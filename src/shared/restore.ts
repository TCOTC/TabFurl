import {getSubTree} from './bookmarks'
import {UNGROUPED_FOLDER_NAME} from './naming'
import type {BookmarkNode, RestoreOptions, RestoreResult} from './types'
import {isInternalUrl} from './urls'

interface PlannedGroup {
  /** 空字符串表示「不建分组」。 */
  title: string
  urls: string[]
}

interface PlannedRestore {
  groups: PlannedGroup[]
  skipped: number
}

/**
 * 只处理一层子文件夹，与「按子文件夹（一层）创建分组」的需求一致。
 * 更深的嵌套会被跳过并计入 skipped，不会静默丢书签。
 */
export function planRestore(folder: BookmarkNode, options: RestoreOptions): PlannedRestore {
  const children = folder.children ?? []
  const groups: PlannedGroup[] = []
  let skipped = 0

  for (const child of children) {
    if (child.url) continue

    const urls: string[] = []
    for (const grandChild of child.children ?? []) {
      if (!grandChild.url) {
        skipped++
        continue
      }
      if (isInternalUrl(grandChild.url)) {
        skipped++
        continue
      }
      urls.push(grandChild.url)
    }
    if (urls.length > 0) groups.push({title: child.title, urls})
  }

  // 会话文件夹顶层的散装书签（窗口里没有分组的那些）。
  const looseUrls: string[] = []
  for (const child of children) {
    if (!child.url) continue
    if (isInternalUrl(child.url)) {
      skipped++
      continue
    }
    looseUrls.push(child.url)
  }
  if (looseUrls.length > 0) {
    groups.push({title: options.groupUngrouped ? UNGROUPED_FOLDER_NAME : '', urls: looseUrls})
  }

  return {groups, skipped}
}

/** 按计划打开标签，返回每个分组拿到的 tabId。 */
async function openTabs(
  planned: readonly PlannedGroup[],
  target: RestoreOptions['target']
): Promise<{created: {group: PlannedGroup; tabIds: number[]}[]; opened: number}> {
  const created: {group: PlannedGroup; tabIds: number[]}[] = []

  // 「当前窗口」先取到 windowId，后续标签全部落在这里；
  // 「新窗口」则留空，由第一个标签顺手把窗口建出来，避免先开空窗口再补标签的闪烁。
  let windowId: number | undefined
  if (target === 'currentWindow') {
    windowId = (await chrome.windows.getCurrent()).id
  }

  let opened = 0

  for (const group of planned) {
    const tabIds: number[] = []

    for (const url of group.urls) {
      if (windowId === undefined) {
        const newWindow = await chrome.windows.create({url, focused: true})
        if (!newWindow) throw new Error('无法创建新窗口')
        windowId = newWindow.id
        const tabId = newWindow.tabs?.[0]?.id
        if (tabId !== undefined) tabIds.push(tabId)
      } else {
        const tab = await chrome.tabs.create({
          url,
          windowId,
          // 当前窗口模式下让第一个标签可见，否则用户看不到任何反应。
          active: target === 'currentWindow' && opened === 0
        })
        if (tab.id !== undefined) tabIds.push(tab.id)
      }
      opened++
    }

    created.push({group, tabIds})
  }

  return {created, opened}
}

/**
 * @types/chrome 把 tabs.group 的 tabIds 声明为非空元组，这里收窄成实际语义：
 * 调用方已保证入参非空，直接断言比在每个调用点展开元组更干净。
 */
function asNonEmptyTabIds(tabIds: readonly number[]): [number, ...number[]] {
  return tabIds as unknown as [number, ...number[]]
}

/** 建标签分组。 */
async function applyGroups(
  created: readonly {group: PlannedGroup; tabIds: number[]}[],
  windowId: number | undefined,
  options: RestoreOptions
): Promise<number> {
  if (windowId === undefined) return 0

  let count = 0
  for (const {group, tabIds} of created) {
    if (tabIds.length === 0) continue
    if (!group.title && !options.groupUngrouped) continue

    try {
      const groupId = await chrome.tabs.group({
        tabIds: asNonEmptyTabIds(tabIds),
        createProperties: {windowId}
      })
      const title = group.title || UNGROUPED_FOLDER_NAME
      await chrome.tabGroups.update(groupId, {title})
      count++
    } catch (error) {
      // 分组失败不该让整次还原失败：标签已经打开了。
      console.error('[tabfurl] 创建标签分组失败', group.title, error)
    }
  }
  return count
}

/** 把一个存档文件夹还原成窗口 + 标签分组。 */
export async function restoreFolder(
  folderId: string,
  options: RestoreOptions
): Promise<RestoreResult> {
  const folder = await getSubTree(folderId)
  if (!folder) throw new Error('找不到该收藏文件夹，可能已被删除')

  const planned = planRestore(folder, options)
  const nonEmpty = planned.groups.filter((group) => group.urls.length > 0)
  if (nonEmpty.length === 0) {
    return {opened: 0, groups: 0, skipped: planned.skipped}
  }

  const {created, opened} = await openTabs(nonEmpty, options.target)
  const windowId = await currentWindowId(created)
  const groups = await applyGroups(created, windowId, options)

  return {opened, groups, skipped: planned.skipped}
}

/** openTabs 之后反查窗口 id：拿第一个标签所在窗口即可。 */
async function currentWindowId(
  created: readonly {tabIds: number[]}[]
): Promise<number | undefined> {
  const firstTabId = created.flatMap((item) => item.tabIds)[0]
  if (firstTabId === undefined) return undefined
  try {
    const tab = await chrome.tabs.get(firstTabId)
    return tab.windowId
  } catch {
    return undefined
  }
}

/**
 * 文件夹启动器：为每个文件夹各开一个标签页（渲染 `pages/folder.html`）。
 * 这是本项目存在的理由之一——浏览器自带的收藏夹做不到并排打开多个文件夹。
 */
export async function openFolderViewers(folderIds: readonly string[]): Promise<number> {
  let opened = 0
  for (const folderId of folderIds) {
    const url = chrome.runtime.getURL(
      `pages/folder.html?id=${encodeURIComponent(folderId)}`
    )
    await chrome.tabs.create({url, active: opened === 0})
    opened++
  }
  return opened
}
