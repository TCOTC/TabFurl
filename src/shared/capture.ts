import {createBookmark, createFolder} from './bookmarks'
import {groupFolderName} from './naming'
import type {
  SaveResult,
  TabGroupBucket,
  TabGroupColor,
  TabSnapshot,
  WindowSnapshot
} from './types'
import {isInternalUrl} from './urls'

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
      // MV3 下 query 回来的标签一定有 id（与下面 url 的断言同理）：界面里勾选它靠这个值。
      tabId: tab.id as number,
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

/**
 * 窗口里的一个直接子级：分组是子文件夹，未分组的标签是散装书签。
 *
 * 导出给界面用：勾选清单必须按同一顺序渲染，否则「看到的」与「存下的」会不一致；
 * 拖拽也用它——拖一条标签就是拖一个 `kind: 'tab'` 的子级。
 */
export type WindowChild =
  | {kind: 'group'; name: string; tabs: readonly TabSnapshot[]}
  | {kind: 'tab'; tab: TabSnapshot}

/**
 * 按窗口顺序排列这一层的子级。
 *
 * 分组的次序取组内第一个标签的 index；Chrome 的标签栏里同一分组的标签必定连续，
 * 所以按 index 归并得到的就是窗口里「未分组段 / 分组 / 未分组段 …」的真实次序。
 * 这样未分组的标签会留在原位，而不会被集中挑到末尾。
 */
export function planWindowChildren(snapshot: WindowSnapshot): WindowChild[] {
  const ordered: {index: number; child: WindowChild}[] = []

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

/** 写入一组标签，收集新建的书签 id（撤销要用）。 */
async function writeTabs(
  folderId: string,
  tabs: readonly TabSnapshot[],
  result: SaveResult
): Promise<void> {
  for (const tab of tabs) {
    const created = await createBookmark(folderId, tab.title, tab.url)
    result.bookmarkIds.push(created.id)
    result.saved++
  }
}

/**
 * 把一串子级写进**指定的**文件夹。
 *
 * 结构（详见 `docs/design.md` 三）：分组建成子文件夹，未分组的标签在那一层就地成散装书签，
 * 顺序即传入顺序。**同名文件夹允许共存**，不合并、也不追加序号——
 * 书签树本来就允许同级同名，而且用户在不同窗口里可能真的有两个叫「工作」的分组。
 *
 * 它是保存侧唯一的写入入口，所以整窗保存与「拖一条标签过去」走的是同一条路径。
 *
 * @param parentId 目标文件夹（可以是存档根，也可以是它下面的某个分组文件夹）。
 */
export async function writeChildren(
  parentId: string,
  children: readonly WindowChild[]
): Promise<SaveResult> {
  const result: SaveResult = {saved: 0, groups: 0, skipped: 0, folderIds: [], bookmarkIds: []}

  for (const child of children) {
    if (child.kind === 'tab') {
      await writeTabs(parentId, [child.tab], result)
      continue
    }

    const folder = await createFolder(parentId, child.name)
    result.folderIds.push(folder.id)
    result.groups++
    await writeTabs(folder.id, child.tabs, result)
  }

  return result
}

/** 合并多次写入的结果（界面上一次动作可能写了好几处）。 */
export function mergeSaveResults(results: readonly SaveResult[]): SaveResult {
  return results.reduce<SaveResult>(
    (sum, item) => ({
      saved: sum.saved + item.saved,
      groups: sum.groups + item.groups,
      skipped: sum.skipped + item.skipped,
      folderIds: [...sum.folderIds, ...item.folderIds],
      bookmarkIds: [...sum.bookmarkIds, ...item.bookmarkIds]
    }),
    {saved: 0, groups: 0, skipped: 0, folderIds: [], bookmarkIds: []}
  )
}

/** 快照里的标签总数（已被过滤掉的内部页面不算）。 */
export function countSnapshotTabs(snapshot: WindowSnapshot): number {
  return snapshot.groups.reduce((sum, bucket) => sum + bucket.tabs.length, 0) +
    snapshot.ungrouped.length
}

/**
 * 按勾选结果裁剪快照：剔除被排除的标签，并丢掉因此变空的标签分组。
 *
 * 窗口顺序原样保留，所以裁剪后的快照写出来仍是「未分组段 / 分组 / …」的交替。
 * 界面用它与 `countSnapshotTabs` 算「将保存 N 个标签页」，与真正写入的是同一份数据。
 */
export function selectTabs(
  snapshot: WindowSnapshot,
  excludeTabIds: ReadonlySet<number>
): WindowSnapshot {
  if (excludeTabIds.size === 0) return snapshot

  return {
    ...snapshot,
    groups: snapshot.groups
      .map((bucket) => ({
        ...bucket,
        tabs: bucket.tabs.filter((tab) => !excludeTabIds.has(tab.tabId))
      }))
      .filter((bucket) => bucket.tabs.length > 0),
    ungrouped: snapshot.ungrouped.filter((tab) => !excludeTabIds.has(tab.tabId))
  }
}
