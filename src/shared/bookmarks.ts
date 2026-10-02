import type {BookmarkNode, FolderOption} from './types'
import {isInternalUrl} from './urls'

/** Chrome 内置文件夹「其他书签」的固定 id。 */
const OTHER_BOOKMARKS_ID = '2'

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

/** 删除整个子树，用于「撤销本次保存」。 */
export async function removeSubTree(id: string): Promise<void> {
  await chrome.bookmarks.removeTree(id)
}

/**
 * 找存档根的落点：固定在「其他书签」，避免污染书签栏。
 *
 * Chrome 把内置文件夹的 id 固定为 `1`（书签栏）、`2`（其他书签）、`3`（移动设备书签，
 * 仅在开启了同步时存在）。所以优先认 `2`；取不到时退化为最后一个顶级文件夹。
 */
export async function findArchiveParentId(): Promise<string> {
  const roots = await getRoots()
  const children = roots[0]?.children ?? []
  if (children.length === 0) {
    throw new Error('书签树为空，无法创建存档根文件夹')
  }

  const preferred = children.find((child) => child.id === OTHER_BOOKMARKS_ID)
  return (preferred ?? children[children.length - 1]).id
}

/** 在 parentId 下找同名文件夹；不存在返回 undefined。 */
export async function findChildFolder(
  parentId: string,
  title: string
): Promise<BookmarkNode | undefined> {
  const children = await getChildren(parentId)
  return children.find((child) => !child.url && child.title === title)
}

function countBookmarks(node: BookmarkNode): number {
  if (node.url) return isInternalUrl(node.url) ? 0 : 1
  return (node.children ?? []).reduce((total, child) => total + countBookmarks(child), 0)
}

/**
 * 把存档根展开成扁平列表，供主界面与启动器使用。
 * 顺序即书签树里的前序遍历顺序，所以会话文件夹天然按时间排列。
 */
export async function listFolders(archiveRootId: string): Promise<FolderOption[]> {
  const root = await getSubTree(archiveRootId)
  if (!root) return []

  const options: FolderOption[] = []

  const walk = (node: BookmarkNode, path: string[]): void => {
    for (const child of node.children ?? []) {
      if (child.url) continue
      const childPath = [...path, child.title]
      const grandChildren = child.children ?? []
      options.push({
        id: child.id,
        title: child.title,
        path,
        bookmarkCount: grandChildren.filter((item) => Boolean(item.url)).length,
        totalBookmarkCount: countBookmarks(child),
        folderCount: grandChildren.filter((item) => !item.url).length
      })
      walk(child, childPath)
    }
  }

  walk(root, [])
  return options
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

/**
 * 取（必要时创建）存档根文件夹。
 *
 * 优先复用同名文件夹，避免用户重复点「创建」时在书签树里堆出好几份存档。
 */
export async function ensureArchiveRoot(name: string): Promise<BookmarkNode> {
  const parentId = await findArchiveParentId()
  const existing = await findChildFolder(parentId, name)
  if (existing) return existing
  return createFolder(parentId, name)
}
