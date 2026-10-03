import {isOpenableBookmark, openableBookmarks} from '../shared/bookmarks'
import type {BookmarkNode} from '../shared/types'

/**
 * 某一层里「会被打开」的书签 id：散装书签 + 每个直属子文件夹里的书签。
 * 与 `restoreFolder` 同口径：只一层、不算记号、不算内部页面、不算文件夹本身。
 * 判定统一走 `isOpenableBookmark()`，**别在别处再写一遍这几个条件**（写两遍必然分叉）。
 */
export function archiveBookmarkIds(children: readonly BookmarkNode[]): string[] {
  return children.flatMap((child) => {
    if (!child.url) return folderBookmarkIds(child)
    return isOpenableBookmark(child) ? [child.id] : []
  })
}

/**
 * 一个子文件夹里「会被打开」的书签 id。
 * 记号与内部页面都不在内（它们没有勾选框，也不参与计数）。
 */
export function folderBookmarkIds(folder: BookmarkNode): string[] {
  return openableBookmarks(folder.children ?? []).map((bookmark) => bookmark.id)
}

/** 名单里还剩几枚没被排除。 */
export function keptCount(ids: readonly string[], excluded: ReadonlySet<string>): number {
  return ids.filter((id) => !excluded.has(id)).length
}

/** 某一层里「能干活的东西」的枚数（子文件夹可以进去，书签可以打开）。胸章与 `count()` 都用它。 */
export function countValue(children: readonly BookmarkNode[]): number {
  return children.filter((child) => !child.url).length + openableBookmarks(children).length
}
