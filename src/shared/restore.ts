import {getSubTree} from './bookmarks'
import type {BookmarkNode, RestoreOptions, RestoreResult} from './types'
import {bookmarkManagerUrl, isInternalUrl, isSeparatorUrl} from './urls'

export interface PlannedBookmark {
  /** 书签 id；界面里取消勾选某一枚标签时用它。 */
  id: string
  title: string
  url: string
  /**
   * 这是一枚记号（分隔线或间隔，`isSeparatorUrl` 认出的占位书签）。
   * 计划里**留着**它，是为了让按同一份计划遍历的地方不漏掉一条（顺序即书签树顺序）；
   * 但它不是要打开的页面：还原时跳过，计数时不算作标签。
   */
  separator: boolean
}

/**
 * 一个直接子级。`title` 非空 = 标签分组（对应子文件夹）；空串 = 「这些标签不建分组」的散装书签。
 * 数组顺序即书签树顺序，也就是原来窗口里的顺序。
 */
export interface PlannedItem {
  /** 分组对应的子文件夹 id；散装书签项没有它。 */
  folderId?: string
  title: string
  bookmarks: PlannedBookmark[]
}

export interface RestorePlan {
  items: PlannedItem[]
  /** 被跳过的条目数：浏览器内部页面，以及子文件夹的子文件夹。分隔线不算——它不是「丢了东西」。 */
  skipped: number
}

function plannedBookmark(node: BookmarkNode): PlannedBookmark {
  const url = node.url as string
  return {id: node.id, title: node.title, url, separator: isSeparatorUrl(url)}
}

/** 计划里真正会被打开的标签。分隔线只是记号，不在此列。 */
export function restorableBookmarks(bookmarks: readonly PlannedBookmark[]): PlannedBookmark[] {
  return bookmarks.filter((bookmark) => !bookmark.separator)
}

/**
 * 只处理**一层**子文件夹（对应「按子文件夹创建分组」）。更深的嵌套计入 `skipped`，不静默丢书签。
 * 散装书签保留在原位（相邻的合成一项）→ 还原出来的标签顺序与保存时一致。
 * 界面也用这份计划渲染勾选清单 → 「看到的」与「还原的」同一口径。
 * 分隔线（`PlannedBookmark.separator`）留在原位供渲染，只是不会被打开。
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
    // 只有分隔线的分组等于空分组：留着只会渲染出一个有标题、却一枚标签都没有的框。
    if (bookmarks.some((bookmark) => !bookmark.separator)) {
      items.push({folderId: child.id, title: child.title, bookmarks})
    }
  }

  return {items, skipped}
}

/** 剔除不还原的书签，并丢掉因此变空的分组。界面算枚数与还原本身走同一条路 → 口径不可能不一致。 */
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

/** 按计划打开标签，返回每项拿到的 tabId 与「保持加载的那一枚」（第一个标签 = 活动标签）。 */
async function openTabs(
  planned: readonly PlannedItem[],
  target: RestoreOptions['target']
): Promise<{
  created: {item: PlannedItem; tabIds: number[]}[]
  opened: number
  keepLoadedTabId: number | undefined
}> {
  const created: {item: PlannedItem; tabIds: number[]}[] = []

  // 「新窗口」留空 windowId，由第一个标签顺手把窗口建出来，避免先开空窗口再补标签的闪烁。
  let windowId: number | undefined
  if (target === 'currentWindow') {
    windowId = (await chrome.windows.getCurrent()).id
  }

  let opened = 0
  let keepLoadedTabId: number | undefined

  for (const item of planned) {
    const tabIds: number[] = []

    for (const {url, separator} of item.bookmarks) {
      // 分隔线是占位书签，打开它只会多一个无用标签 → 渲染照旧，打开时跳过。
      if (separator) continue

      // 第一个标签无论哪种模式都会成为活动标签；它不能（也不该）被舍弃。
      const isFirst = keepLoadedTabId === undefined

      if (windowId === undefined) {
        const newWindow = await chrome.windows.create({url, focused: true})
        if (!newWindow) throw new Error('无法创建新窗口')
        windowId = newWindow.id
        const tabId = newWindow.tabs?.[0]?.id
        if (tabId !== undefined) {
          tabIds.push(tabId)
          if (isFirst) keepLoadedTabId = tabId
        }
      } else {
        const tab = await chrome.tabs.create({
          url,
          windowId,
          // 当前窗口模式下让第一个标签可见，否则用户看不到任何反应。
          active: target === 'currentWindow' && opened === 0
        })
        if (tab.id !== undefined) {
          tabIds.push(tab.id)
          if (isFirst) keepLoadedTabId = tab.id
        }
      }
      opened++
    }

    created.push({item, tabIds})
  }

  return {created, opened, keepLoadedTabId}
}

/** 舍弃前等待导航提交的节奏。抽成参数是为了让测试能用毫秒级的时间跑完。 */
export interface DiscardTiming {
  /** 轮询间隔。 */
  pollMs: number
  /** 总超时；超时后放弃舍弃，宁可留着加载。 */
  timeoutMs: number
}

/**
 * 默认节奏：每 50ms 问一次，最多等 2 秒。超时是为了**状态栏不至于卡太久**：`restoreFolder` 是同步等的，
 * 只要有一枚迟迟不提交（对方服务器没响应），用户就一直看着「正在打开…」。超时的就干脆留着加载。
 */
const DEFAULT_DISCARD_TIMING: DiscardTiming = {pollMs: 50, timeoutMs: 2000}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 导航是否**已提交**（因而可以安全舍弃）。
 * `Tab.url` 是「主框架**上次已提交**的网址」，未提交时是空串、目标只在 `pendingUrl` 里。
 * 三个条件取最保守的一支：宁可少舍弃几枚，也不能丢掉地址。
 */
function isCommitted(tab: chrome.tabs.Tab): boolean {
  return Boolean(tab.url) && tab.url !== 'about:blank' && tab.pendingUrl === undefined
}

/**
 * 把**已提交导航**的标签舍弃掉——它们仍留在标签栏里，点开时才真正加载。
 *
 * `tabs.create()` 没有「先不加载」选项（传了 `url` 就立即加载），一次还原几十个标签会并发加载卡顿
 * → `tabs.discard()` 正是这个语义。**但必须先等导航提交**：`discard` 是靠**已提交的地址**
 * 在激活时重载，标签还没有已提交地址时 Chrome 没有可恢复的地址 → 标签变成 `about:blank`
 *（2026-10-03 实测到的 bug，不是推测）→ 所以轮询到 `url` 有值才动手，超时就不碰它。
 *
 * **活动标签无法被舍弃**（API 限制），每个窗口会留一枚已加载的。
 */
export async function discardCommittedTabs(
  tabIds: readonly number[],
  options: {keepLoadedTabId?: number; timing?: DiscardTiming} = {}
): Promise<number> {
  const {keepLoadedTabId, timing = DEFAULT_DISCARD_TIMING} = options
  const pending = new Set(tabIds.filter((tabId) => tabId !== keepLoadedTabId))
  const deadline = Date.now() + timing.timeoutMs
  let discarded = 0

  while (pending.size > 0 && Date.now() < deadline) {
    for (const tabId of [...pending]) {
      let tab: chrome.tabs.Tab
      try {
        tab = await chrome.tabs.get(tabId)
      } catch {
        // 标签已经被关掉了，没什么可舍弃的。
        pending.delete(tabId)
        continue
      }

      if (!isCommitted(tab)) continue

      pending.delete(tabId)
      try {
        await chrome.tabs.discard(tabId)
        discarded++
      } catch (error) {
        // 舍弃失败不该让整次还原失败：标签已经打开了，只是会真加载而已。
        console.error('[tabfurl] 舍弃标签失败', tabId, error)
      }
    }

    if (pending.size > 0) await delay(timing.pollMs)
  }

  if (pending.size > 0) {
    // 不是错误：这些标签会照常加载，只是没省下内存。
    console.info(`[tabfurl] ${pending.size} 个标签在 ${timing.timeoutMs}ms 内未提交导航，保持加载`)
  }

  return discarded
}

/**
 * `@types/chrome` 把 `tabs.group` 的 tabIds 声明为非空元组；调用方已保证非空 → 直接断言比每个调用点展开元组干净。
 */
function asNonEmptyTabIds(tabIds: readonly number[]): [number, ...number[]] {
  return tabIds as unknown as [number, ...number[]]
}

/** 建标签分组。`title` 为空的项是散装标签，本来就不该有分组。 */
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
 * 把一个文件夹还原成窗口，或只开标签页（`groupTabs: false`）。
 * 传 `excludeBookmarkIds` 时，被勾掉的书签不打开，因此变空的分组也不创建。
 */
export async function restoreFolder(
  folderId: string,
  options: RestoreOptions
): Promise<RestoreResult> {
  const folder = await getSubTree(folderId)
  if (!folder) throw new Error('找不到该收藏文件夹，可能已被删除')

  const plan = applyExclusions(planRestore(folder), options.excludeBookmarkIds)
  if (plan.items.length === 0) {
    return {opened: 0, groups: 0, skipped: plan.skipped, discarded: 0}
  }

  const {created, opened, keepLoadedTabId} = await openTabs(plan.items, options.target)
  const groups = options.groupTabs === false
    ? 0
    : await applyGroups(created, await currentWindowId(created))

  // 舍弃放在最后：分组、窗口都建好了，标签的位置与归属都已固定，此时卸载最安全。
  const discarded = await discardCommittedTabs(created.flatMap((item) => item.tabIds), {
    keepLoadedTabId
  })

  return {opened, groups, skipped: plan.skipped, discarded}
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
 * 在浏览器自带书签管理器里打开这个文件夹。
 *
 * 它取代了早期的「阅读页」（扩展自己渲染一整页卡片）：那等于长期维护第二个界面，而它想解决的问题
 *（看一层文件夹的全貌、批量整理）浏览器做得更好。详细论证见 `docs/design.md` 七。
 * 传的是数字 id（`?id=` 认它；154.x 上「落在默认层」是上游回归，见 `bookmarkManagerUrl`）。
 *
 * `chrome://` 不能无脑跳（扩展的访问被限制在白名单里）→ 被挡下来时抛一句**可操作**的错（告知快捷键），
 * 而不是把 API 的原始错误丢给用户。
 */
export async function openInBookmarkManager(folderId: string): Promise<void> {
  try {
    await chrome.tabs.create({url: bookmarkManagerUrl(folderId), active: true})
  } catch {
    throw new Error('浏览器不允许扩展打开书签管理器，请按 Ctrl+Shift+O 打开后再找这个文件夹')
  }
}
