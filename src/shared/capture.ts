import {createBookmark, createFolder, getChildTitles} from './bookmarks'
import {
  dedupeName,
  formatSessionName,
  formatTimestamp,
  groupFolderName,
  sanitizeFolderName
} from './naming'
import type {
  CaptureResult,
  SessionNameMode,
  TabGroupBucket,
  TabGroupColor,
  TabSnapshot,
  WindowSnapshot
} from './types'
import {hostnameOf, isInternalUrl} from './urls'

const GROUP_COLORS: readonly TabGroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
]

function isTabGroupColor(value: string | undefined): value is TabGroupColor {
  return value !== undefined && (GROUP_COLORS as readonly string[]).includes(value)
}

interface GroupMeta {
  title: string
  color?: TabGroupColor
}

/** 读取当前窗口的标签页并按分组聚合，内部页面会被过滤掉。 */
export async function snapshotCurrentWindow(): Promise<WindowSnapshot> {
  const tabs = await chrome.tabs.query({currentWindow: true})

  // 先按 groupId 解析分组标题。manifest 的 minimum_chrome_version 已保证 tabGroups 可用。
  const groupMeta = new Map<number, GroupMeta>()
  for (const tab of tabs) {
    const groupId = tab.groupId
    if (groupId === undefined || groupId < 0 || groupMeta.has(groupId)) continue
    try {
      const group = await chrome.tabGroups.get(groupId)
      groupMeta.set(groupId, {
        title: group.title ?? '',
        color: isTabGroupColor(group.color) ? group.color : undefined
      })
    } catch {
      groupMeta.set(groupId, {title: ''})
    }
  }

  const buckets: TabGroupBucket[] = []
  const bucketByGroupId = new Map<number, TabGroupBucket>()
  const ungrouped: TabSnapshot[] = []
  let skipped = 0

  for (const tab of tabs) {
    if (isInternalUrl(tab.url)) {
      skipped++
      continue
    }

    const snapshot: TabSnapshot = {
      title: (tab.title || tab.url || '').trim(),
      url: tab.url as string,
      pinned: tab.pinned ?? false,
      index: tab.index,
      lastAccessed: tab.lastAccessed
    }

    const groupId = tab.groupId
    if (groupId === undefined || groupId < 0) {
      ungrouped.push(snapshot)
      continue
    }

    const meta = groupMeta.get(groupId) ?? {title: ''}
    snapshot.groupTitle = meta.title
    snapshot.groupColor = meta.color

    // 按 groupId 分桶：不同分组允许同名，不能按标题合并。
    let bucket = bucketByGroupId.get(groupId)
    if (!bucket) {
      bucket = {title: meta.title, color: meta.color, tabs: []}
      bucketByGroupId.set(groupId, bucket)
      buckets.push(bucket)
    }
    bucket.tabs.push(snapshot)
  }

  return {
    windowId: tabs[0]?.windowId ?? chrome.windows.WINDOW_ID_CURRENT,
    capturedAt: Date.now(),
    groups: buckets,
    ungrouped,
    skipped
  }
}

/** 当前活动标签的主机名，仅用于会话命名。 */
async function activeSiteLabel(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true})
  return hostnameOf(tab?.url)
}

/** 写入一组标签。返回实际写入数量。 */
async function writeTabs(folderId: string, tabs: readonly TabSnapshot[]): Promise<number> {
  let written = 0
  for (const tab of tabs) {
    await createBookmark(folderId, tab.title, tab.url)
    written++
  }
  return written
}

/** 会话文件夹的直接子级：分组建成子文件夹，未分组的标签是散装书签。 */
type SessionChild =
  | {kind: 'group'; name: string; tabs: readonly TabSnapshot[]}
  | {kind: 'tab'; tab: TabSnapshot}

/**
 * 按窗口顺序排列会话文件夹的子级。
 *
 * 分组的次序取组内第一个标签的 index；Chrome 的标签栏里同一分组的标签必定连续，
 * 所以按 index 归并得到的就是窗口里「未分组段 / 分组 / 未分组段 …」的真实次序。
 * 这样未分组的标签会留在原位，而不会被集中挑到末尾。
 */
function planSessionChildren(snapshot: WindowSnapshot): SessionChild[] {
  const ordered: {index: number; child: SessionChild}[] = []

  for (const bucket of snapshot.groups) {
    const first = bucket.tabs[0]
    if (!first) continue
    ordered.push({
      index: first.index,
      child: {kind: 'group', name: groupFolderName(bucket), tabs: bucket.tabs}
    })
  }

  for (const tab of snapshot.ungrouped) {
    ordered.push({index: tab.index, child: {kind: 'tab', tab}})
  }

  // index 在窗口内唯一，按它排序即窗口顺序。
  ordered.sort((a, b) => a.index - b.index)
  return ordered.map((entry) => entry.child)
}

/**
 * 把当前窗口存成书签文件夹。
 *
 * 结构约定（详见 docs/design.md）：
 * ```
 * 标签页存档/
 *   2026-10-02 14_30/     ← 会话文件夹
 *     工作/               ← 标签分组
 *     wikipedia.org       ← 窗口里没进分组的标签，散装书签
 *     阅读/
 * ```
 * 会话文件夹的直接子级严格按窗口顺序排列。窗口里一个分组都没有时，结果就是
 * 一列散装书签——不需要额外的「未分组」层，所以「保存 → 还原」始终对称。
 */
export async function captureCurrentWindow(
  archiveRootId: string,
  sessionNameMode: SessionNameMode
): Promise<CaptureResult> {
  const snapshot = await snapshotCurrentWindow()
  const total = snapshot.groups.reduce((sum, bucket) => sum + bucket.tabs.length, 0) +
    snapshot.ungrouped.length

  // 一条都存不了就不要留下空文件夹。
  if (total === 0) {
    return {folderId: '', folderName: '', saved: 0, skipped: snapshot.skipped, groups: 0}
  }

  const date = new Date(snapshot.capturedAt)
  const site = sessionNameMode === 'datetimeSite' ? await activeSiteLabel() : undefined
  const desired = formatSessionName(date, sessionNameMode, site)
  const sessionName = dedupeName(
    sanitizeFolderName(desired, formatTimestamp(date)),
    await getChildTitles(archiveRootId)
  )
  const sessionFolder = await createFolder(archiveRootId, sessionName)

  let saved = 0
  let groups = 0

  for (const child of planSessionChildren(snapshot)) {
    if (child.kind === 'tab') {
      await createBookmark(sessionFolder.id, child.tab.title, child.tab.url)
      saved++
      continue
    }

    const name = dedupeName(child.name, await getChildTitles(sessionFolder.id))
    const folder = await createFolder(sessionFolder.id, name)
    groups++
    saved += await writeTabs(folder.id, child.tabs)
  }

  return {
    folderId: sessionFolder.id,
    folderName: sessionFolder.title,
    saved,
    skipped: snapshot.skipped,
    groups
  }
}

/** 侧边栏里「将保存 N 个标签页」的计数，不产生任何写入。 */
export async function countCapturableTabs(): Promise<{saveable: number; skipped: number}> {
  const snapshot = await snapshotCurrentWindow()
  const saveable = snapshot.groups.reduce((sum, bucket) => sum + bucket.tabs.length, 0) +
    snapshot.ungrouped.length
  return {saveable, skipped: snapshot.skipped}
}
