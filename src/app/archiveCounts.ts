import {isRealBookmark, realBookmarks} from '../shared/bookmarks'
import type {BookmarkNode} from '../shared/types'

/**
 * 某一层里「会被打开」的书签 id：散装书签 + 每个直属子文件夹里的书签。
 *
 * **必须与 `restoreFolder` 同口径**（它只处理一层、且跳过分隔线）：否则「打开（N）」多算，
 * 而且全选框按这份名单算总数，总数里混进永远勾不上的项 → 永远停在「部分选择」。
 */
export function archiveBookmarkIds(children: readonly BookmarkNode[]): string[] {
  return children.flatMap((child) => {
    if (!child.url) return folderBookmarkIds(child)
    return isRealBookmark(child) ? [child.id] : []
  })
}

/** 一个子文件夹里「会被打开」的书签 id。分隔线不在内：它没有勾选框，也不参与计数。 */
export function folderBookmarkIds(folder: BookmarkNode): string[] {
  return realBookmarks(folder.children ?? []).map((bookmark) => bookmark.id)
}

/** 名单里还剩几枚没被排除。 */
export function keptCount(ids: readonly string[], excluded: ReadonlySet<string>): number {
  return ids.filter((id) => !excluded.has(id)).length
}

/** 某一层里「能干活的东西」的枚数（子文件夹可以进去，书签可以打开）。胸章与 `count()` 都用它。 */
export function countValue(children: readonly BookmarkNode[]): number {
  return children.filter((child) => !child.url).length + realBookmarks(children).length
}
