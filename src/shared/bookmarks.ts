import type {BookmarkNode, FolderOption} from './types'
import {isInternalUrl} from './urls'

/** Chrome 内置文件夹「书签栏」的固定 id。 */
const BOOKMARKS_BAR_ID = '1'

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

/**
 * 书签树根。Chrome 下是 `[{id: '0', children: [书签栏, 其他书签, 移动设备书签]}]`。
 */
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

/** 同级已有文件夹名，交给 `dedupeName()` 去重。 */
export async function getChildTitles(id: string): Promise<string[]> {
  return (await getChildren(id)).map((child) => child.title)
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
 * 重命名文件夹或书签。
 *
 * 清洗与去重都不在这里做：名字由用户在界面上直接输入，`sanitizeFolderName` 负责清洗，
 * 重名则按浏览器自己的语义放行（Chrome 允许同级重名，界面以位置区分）。
 */
export async function renameNode(id: string, title: string): Promise<BookmarkNode> {
  return toNode(await chrome.bookmarks.update(id, {title}))
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

/** 从节点一路向上收集标题，用于在界面上显示完整位置。 */
export async function getNodePath(id: string): Promise<string[]> {
  const titles: string[] = []
  let current = await getNode(id)

  // 50 层足够，同时防止书签树出现环时死循环。
  for (let depth = 0; current && depth < 50; depth++) {
    titles.unshift(current.title || '书签')
    if (!current.parentId) break
    current = await getNode(current.parentId)
  }
  return titles
}

/** 统计一个文件夹下的全部可收藏书签（递归，跳过内部页面）。 */
function countBookmarks(node: BookmarkNode): number {
  if (node.url) return isInternalUrl(node.url) ? 0 : 1
  return (node.children ?? []).reduce((total, child) => total + countBookmarks(child), 0)
}

function describeFolder(node: BookmarkNode, path: string[]): FolderOption {
  const children = node.children ?? []
  return {
    id: node.id,
    title: node.title,
    path,
    bookmarkCount: children.filter((child) => Boolean(child.url)).length,
    totalBookmarkCount: countBookmarks(node),
    folderCount: children.filter((child) => !child.url).length
  }
}

/**
 * 把 rootId 展开成扁平文件夹列表，供主界面与启动器使用。
 * 顺序即书签树里的前序遍历顺序，所以会话文件夹天然按时间排列。
 * `includeRoot` 为真时把 rootId 自身也作为第一项（存档根候选列表要用它）。
 */
export async function listFolders(
  archiveRootId: string,
  options: {includeRoot?: boolean} = {}
): Promise<FolderOption[]> {
  const root = await getSubTree(archiveRootId)
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
 * 可作存档根的候选：书签栏自身 + 它下面所有层级的文件夹。
 *
 * 只读——存档位置由用户在「设置」里指定，扩展不负责建文件夹。
 * 返回项的 `path` 一律不含书签栏自己，界面拼显示路径时自行补上头部的 `barTitle`。
 */
export async function listArchiveRootCandidates(): Promise<{
  barTitle: string
  folders: FolderOption[]
}> {
  const barId = await getBookmarksBarId()
  const folders = await listFolders(barId, {includeRoot: true})
  return {barTitle: folders[0]?.title ?? '', folders}
}
