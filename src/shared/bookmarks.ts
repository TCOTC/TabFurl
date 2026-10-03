import type {BookmarkNode, FolderOption} from './types'
import {isInternalUrl, isSeparatorUrl} from './urls'

/** Chrome 内置文件夹「书签栏」的固定 id。 */
const BOOKMARKS_BAR_ID = '1'

/**
 * 节点是不是一枚**真书签**。
 *
 * 分隔线（`isSeparatorUrl`）是书签树里的组织记号，不是书签：不计枚数、无勾选框、还原时跳过，
 * 也不进「打开（N）」。所以**「有没有 url」不能当「是不是书签」用**——以前就是这么写的，
 * 于是分隔线被算进书签数、而界面又把它画成一条线，两边口径对不上。
 * 凡数书签或取书签 id 的地方都必须过这一层。
 */
export function isRealBookmark(node: BookmarkNode): boolean {
  return Boolean(node.url) && !isSeparatorUrl(node.url)
}

/** `isRealBookmark` 的数组版，省去每个调用点各写一遍 `filter`。 */
export function realBookmarks(nodes: readonly BookmarkNode[]): BookmarkNode[] {
  return nodes.filter(isRealBookmark)
}

/**
 * 真书签里，**扩展真的能打开**的那一类。
 *
 * 与 `isRealBookmark` 是两层，别合并：后者回答「是不是书签」（分隔线不是），
 * 这一个回答「打开它会不会多一个标签页」（内部页面不会，`restore.ts` 会跳过它们）。
 * 凡数「会被打开几枚」的地方都要走这一层，否则按钮写 5 枚、实际只开 4 枚。
 */
export function isOpenableBookmark(node: BookmarkNode): boolean {
  return isRealBookmark(node) && !isInternalUrl(node.url)
}

/** `isOpenableBookmark` 的数组版。先前过 `realBookmarks()`，保持「判是不是书签」只有一套。 */
export function openableBookmarks(nodes: readonly BookmarkNode[]): BookmarkNode[] {
  return realBookmarks(nodes).filter((node) => !isInternalUrl(node.url))
}

function toNode(node: chrome.bookmarks.BookmarkTreeNode): BookmarkNode {
  return {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    url: node.url,
    dateAdded: node.dateAdded,
    children: node.children?.map(toNode)
  }
}

/** 书签树根。Chrome 下是 `[{id: '0', children: [书签栏, 其他书签, 移动设备书签]}]`。 */
export async function getRoots(): Promise<BookmarkNode[]> {
  const roots = await chrome.bookmarks.getTree()
  return roots.map(toNode)
}

export async function getNode(id: string): Promise<BookmarkNode | undefined> {
  try {
    const nodes = await chrome.bookmarks.get(id)
    return nodes[0] ? toNode(nodes[0]) : undefined
  } catch {
    // 文件夹被用户删掉后这里的查询会抛错，属于正常情况。
    return undefined
  }
}

/** 取子树（含自身与全部后代）。 */
export async function getSubTree(id: string): Promise<BookmarkNode | undefined> {
  try {
    const nodes = await chrome.bookmarks.getSubTree(id)
    return nodes[0] ? toNode(nodes[0]) : undefined
  } catch {
    return undefined
  }
}

export async function getChildren(id: string): Promise<BookmarkNode[]> {
  try {
    const children = await chrome.bookmarks.getChildren(id)
    return children.map(toNode)
  } catch {
    return []
  }
}

export async function createFolder(parentId: string, title: string): Promise<BookmarkNode> {
  return toNode(await chrome.bookmarks.create({parentId, title}))
}

export async function createBookmark(
  parentId: string,
  title: string,
  url: string
): Promise<BookmarkNode> {
  return toNode(await chrome.bookmarks.create({parentId, title, url}))
}

/** 删除整个子树，用于「撤销本次保存」与删除存档。 */
export async function removeSubTree(id: string): Promise<void> {
  await chrome.bookmarks.removeTree(id)
}

/**
 * 改一个节点的标题与 / 或网址。只按原样写入用户给的值（`sanitizeFolderName` 最多削控制字符与首尾空白）；
 * 重名按浏览器自己的语义放行（Chrome 允许同级重名，界面以位置区分）。
 * 网址只对书签有意义，调用方自己保证不往文件夹上传它，所以这里**不读旧值**：
 * 传什么写什么，没传的字段不动（`chrome.bookmarks.update` 的语义）。
 */
export async function updateNode(
  id: string,
  changes: {title?: string; url?: string}
): Promise<BookmarkNode> {
  return toNode(await chrome.bookmarks.update(id, changes))
}

/**
 * 取书签栏。Chrome 把内置文件夹的 id 固定为 `1`（书签栏）、`2`（其他书签）、
 * `3`（移动设备书签，仅在开启同步时存在），所以认 `1` 即可。
 *
 * 认不出就报错，**绝不退化为「其他书签」**：存档位置只能来自用户的明确指定，
 * 扩展不替用户决定往哪里写。
 */
export async function getBookmarksBarId(): Promise<string> {
  const roots = await getRoots()
  const bar = (roots[0]?.children ?? []).find((child) => child.id === BOOKMARKS_BAR_ID)
  if (!bar) throw new Error('找不到书签栏，无法确定存档位置')
  return bar.id
}

/**
 * 从节点一路向上收集祖先，**含自身**，顺序由浅到深（根在前）。
 *
 * 返回 id 而不只是标题：右栏的面包屑要把每一层做成可点的项（只靠标题的话没法跳）。
 * 根节点的 `title` 是空串，所以兜底成「书签」——否则面包屑首项会是个空白格。
 */
export async function getNodePath(id: string): Promise<{id: string; title: string}[]> {
  const nodes: {id: string; title: string}[] = []
  let current = await getNode(id)

  // 50 层足够，同时防止书签树出现环时死循环。
  for (let depth = 0; current && depth < 50; depth++) {
    nodes.unshift({id: current.id, title: current.title || '书签'})
    if (!current.parentId) break
    current = await getNode(current.parentId)
  }
  return nodes
}

/** 统计一个文件夹下的全部**可打开**书签（递归，跳过内部页面与分隔线）。 */
function countBookmarks(node: BookmarkNode): number {
  if (node.url) return isOpenableBookmark(node) ? 1 : 0
  return (node.children ?? []).reduce((total, child) => total + countBookmarks(child), 0)
}

/** 三个计数与界面同一口径：两个书签数都只算**会被打开**的（内部页面与记号不算）。 */
function describeFolder(node: BookmarkNode, path: string[]): FolderOption {
  const children = node.children ?? []
  return {
    id: node.id,
    title: node.title,
    path,
    bookmarkCount: openableBookmarks(children).length,
    totalBookmarkCount: countBookmarks(node),
    folderCount: children.filter((child) => !child.url).length
  }
}

/**
 * 把 folderId 展开成扁平文件夹列表，供设置页的候选列表使用。
 * 顺序即书签树里的前序遍历顺序，所以同级之间天然按添加时间排列。
 * `includeRoot` 为真时把 folderId 自身也作为第一项。
 */
export async function listFolders(
  folderId: string,
  options: {includeRoot?: boolean} = {}
): Promise<FolderOption[]> {
  // 文件夹被删掉后这个查询会落空，返回空列表而不是抛错——调用方本来就按「候选里没有」处理。
  const root = await getSubTree(folderId)
  if (!root) return []

  const folders: FolderOption[] = options.includeRoot ? [describeFolder(root, [])] : []

  const walk = (node: BookmarkNode, path: string[]): void => {
    for (const child of node.children ?? []) {
      if (child.url) continue
      folders.push(describeFolder(child, path))
      walk(child, [...path, child.title])
    }
  }

  walk(root, [])
  return folders
}

/**
 * 可收藏的文件夹候选：书签栏自身 + 它下面所有层级的文件夹。
 *
 * 只读——收藏哪几层由用户决定，扩展不负责建文件夹。
 * 返回项的 `path` 一律不含书签栏自己，界面拼显示路径时自行补上头部的 `barTitle`。
 */
export async function listBookmarkBarFolders(): Promise<{
  barTitle: string
  folders: FolderOption[]
}> {
  const barId = await getBookmarksBarId()
  const folders = await listFolders(barId, {includeRoot: true})
  return {barTitle: folders[0]?.title ?? '', folders}
}
