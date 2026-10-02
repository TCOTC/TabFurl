import {createBookmark, createFolder, getChildTitles} from './bookmarks'
import {
  dedupeName,
  formatSessionName,
  formatTimestamp,
  groupFolderName,
  sanitizeFolderName,
  ungroupedFolderName
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

/**
 * 把当前窗口存成书签文件夹。
 *
 * 结构约定（详见 docs/design.md）：
 * ```
 * 标签页存档/
 *   2026-10-02 14:30/     ← 会话文件夹
 *     工作/               ← 标签分组
 *     阅读/
 *     未分组/             ← 窗口内没进分组的标签（仅当窗口存在分组时才有这一层）
 * ```
 * 窗口内一个分组都没有时省略桶层，标签直接放进会话文件夹。
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

  if (snapshot.groups.length === 0) {
    saved += await writeTabs(sessionFolder.id, snapshot.ungrouped)
  } else {
    for (const bucket of snapshot.groups) {
      const name = dedupeName(groupFolderName(bucket), await getChildTitles(sessionFolder.id))
      const folder = await createFolder(sessionFolder.id, name)
      groups++
      saved += await writeTabs(folder.id, bucket.tabs)
    }

    if (snapshot.ungrouped.length > 0) {
      const name = dedupeName(ungroupedFolderName(), await getChildTitles(sessionFolder.id))
      const folder = await createFolder(sessionFolder.id, name)
      saved += await writeTabs(folder.id, snapshot.ungrouped)
    }
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
