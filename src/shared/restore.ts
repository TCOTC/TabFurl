import {getSubTree} from './bookmarks'
import type {BookmarkNode, RestoreOptions, RestoreResult} from './types'
import {isInternalUrl} from './urls'

export interface PlannedBookmark {
  /** 书签 id；界面里取消勾选某一枚标签时用它。 */
  id: string
  title: string
  url: string
}

/**
 * 会话文件夹的一个直接子级。
 *
 * `title` 非空是标签分组（对应一个子文件夹）；空串是「这些标签不建分组」的散装书签
 * （窗口里本来就没分组）。数组顺序即书签树里的顺序，也就是原来窗口里的顺序。
 */
export interface PlannedItem {
  /** 分组对应的子文件夹 id；散装书签项没有它。 */
  folderId?: string
  title: string
  bookmarks: PlannedBookmark[]
}

export interface RestorePlan {
  items: PlannedItem[]
  /** 被跳过的条目数：浏览器内部页面，以及子文件夹的子文件夹。 */
  skipped: number
}

function plannedBookmark(node: BookmarkNode): PlannedBookmark {
  return {id: node.id, title: node.title, url: node.url as string}
}

/**
 * 只处理一层子文件夹，与「按子文件夹（一层）创建分组」的需求一致。
 * 更深的嵌套会被跳过并计入 skipped，不会静默丢书签。
 *
 * 散装书签保留在它们原来的位置上（相邻的合并成一项），所以还原出来的窗口
 * 与保存时的标签顺序一致：未分组的标签不会被集中挪到末尾。
 *
 * 界面也用这份计划渲染勾选清单，所以「看到的」与「还原的」是同一口径。
 */
export function planRestore(folder: BookmarkNode): RestorePlan {
  const children = folder.children ?? []
  const items: PlannedItem[] = []
  let skipped = 0

  for (const child of children) {
    if (child.url) {
      if (isInternalUrl(child.url)) {
        skipped++
        continue
      }
      const bookmark = plannedBookmark(child)
      const previous = items.at(-1)
      if (previous && previous.title === '') previous.bookmarks.push(bookmark)
      else items.push({title: '', bookmarks: [bookmark]})
      continue
    }

    const bookmarks: PlannedBookmark[] = []
    for (const grandChild of child.children ?? []) {
      if (!grandChild.url) {
        skipped++
        continue
      }
      if (isInternalUrl(grandChild.url)) {
        skipped++
        continue
      }
      bookmarks.push(plannedBookmark(grandChild))
    }
    if (bookmarks.length > 0) items.push({folderId: child.id, title: child.title, bookmarks})
  }

  return {items, skipped}
}

/**
 * 剔除不还原的书签，并丢掉因此变空的分组。
 *
 * 界面算「将还原 N 个标签」与还原本身都走同一条路，两处口径不可能不一致。
 */
export function applyExclusions(
  plan: RestorePlan,
  excludeBookmarkIds: ReadonlySet<string> | undefined
): RestorePlan {
  if (!excludeBookmarkIds || excludeBookmarkIds.size === 0) return plan

  return {
    skipped: plan.skipped,
    items: plan.items
      .map((item) => ({
        ...item,
        bookmarks: item.bookmarks.filter((bookmark) => !excludeBookmarkIds.has(bookmark.id))
      }))
      .filter((item) => item.bookmarks.length > 0)
  }
}

/** 按计划打开标签，返回每一项拿到的 tabId。 */
async function openTabs(
  planned: readonly PlannedItem[],
  target: RestoreOptions['target']
): Promise<{created: {item: PlannedItem; tabIds: number[]}[]; opened: number}> {
  const created: {item: PlannedItem; tabIds: number[]}[] = []

  // 「当前窗口」先取到 windowId，后续标签全部落在这里；
  // 「新窗口」则留空，由第一个标签顺手把窗口建出来，避免先开空窗口再补标签的闪烁。
  let windowId: number | undefined
  if (target === 'currentWindow') {
    windowId = (await chrome.windows.getCurrent()).id
  }

  let opened = 0

  for (const item of planned) {
    const tabIds: number[] = []

    for (const {url} of item.bookmarks) {
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

    created.push({item, tabIds})
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

/**
 * 建标签分组。`title` 为空的项是散装标签，本来就不该有分组。
 */
async function applyGroups(
  created: readonly {item: PlannedItem; tabIds: number[]}[],
  windowId: number | undefined
): Promise<number> {
  if (windowId === undefined) return 0

  let count = 0
  for (const {item, tabIds} of created) {
    if (tabIds.length === 0 || !item.title) continue

    try {
      const groupId = await chrome.tabs.group({
        tabIds: asNonEmptyTabIds(tabIds),
        createProperties: {windowId}
      })
      await chrome.tabGroups.update(groupId, {title: item.title})
      count++
    } catch (error) {
      // 分组失败不该让整次还原失败：标签已经打开了。
      console.error('[tabfurl] 创建标签分组失败', item.title, error)
    }
  }
  return count
}

/**
 * 把一个存档文件夹还原成窗口，或只开标签页（`groupTabs: false`）。
 *
 * 传 `excludeBookmarkIds` 时，被勾掉的书签不会打开；因此变空的分组也不会创建。
 */
export async function restoreFolder(
  folderId: string,
  options: RestoreOptions
): Promise<RestoreResult> {
  const folder = await getSubTree(folderId)
  if (!folder) throw new Error('找不到该收藏文件夹，可能已被删除')

  const plan = applyExclusions(planRestore(folder), options.excludeBookmarkIds)
  if (plan.items.length === 0) {
    return {opened: 0, groups: 0, skipped: plan.skipped}
  }

  const {created, opened} = await openTabs(plan.items, options.target)
  const groups = options.groupTabs === false
    ? 0
    : await applyGroups(created, await currentWindowId(created))

  return {opened, groups, skipped: plan.skipped}
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
