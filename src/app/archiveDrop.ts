import type {ArchiveDrop, DragPayload} from './dom'

/** 落点对应的「收件层」是哪一个（`into` 是那个文件夹，`here` 是它所在的那一层）。 */
export function dropTargetId(spot: ArchiveDrop): string {
  return spot.kind === 'into' ? spot.folderId : spot.parentId
}

/**
 * 这个落点收不收这份载荷。两种不行，而它们以前都不可能发生（右栏一次只显示一层，锚点永远是兄弟）：
 * **拖到自己身上**；**拖进自己的子孙里**（展开 A 再把 A 拖进它里面那层）。
 * Chrome 也会拒（会成环），但不能等到报错——那会在界面上留下「拖了但没动」而没有任何解释的痕迹。
 * 两个落点都要过这一关：`into` 目标是那个文件夹，`here` 目标是**它所在的那一层**。
 *
 * **多选载荷（`selection`）也得过**：只要目标层在那批里任何一条的子树里就会成环。
 * 以前对非 `folder` 一律放行 → 拖一批到自己展开的子孙上会先画一条提示线，松手才说做不到。
 *
 * 跨栏搬运不要用这个函数：它查的是**本栏**那份父子索引，跨栏时里面没有源那一侧的节点
 * （那种情况由 `TransferPanel` 用 `getNodePath()` 沿目标层父链自己判）。
 */
export function canDropTo(
  payload: DragPayload,
  targetId: string,
  parentById: ReadonlyMap<string, string>
): boolean {
  // 单条的那三类里，只有文件夹会成环；记号与书签不装东西。
  const moving =
    payload.kind === 'folder'
      ? [payload.id]
      : payload.kind === 'selection'
        ? payload.ids
        : []

  for (const id of moving) {
    if (id === targetId) return false
    for (let at = parentById.get(targetId); at !== undefined; at = parentById.get(at)) {
      if (at === id) return false
    }
  }
  return true
}
