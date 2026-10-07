import type {ArchiveRow} from './archiveRows'

/**
 * 把选择**规约成顶层项**：被选中文件夹的后代不再单列一份。
 * 绘制（否则嵌套框一个套一个）与拖拽（否则同一棵子树搬两次）都要它。
 */
export function topLevelPicked(
  pickedIds: ReadonlySet<string>,
  parentById: ReadonlyMap<string, string>
): string[] {
  const out: string[] = []
  for (const id of pickedIds) {
    let nested = false
    for (let at = parentById.get(id); at !== undefined; at = parentById.get(at)) {
      if (pickedIds.has(at)) {
        nested = true
        break
      }
    }
    if (!nested) out.push(id)
  }
  return out
}

/**
 * 这一行归谁的高亮框（沿父链向上找第一个顶层选中项）。
 * 用**规约过**的集合查 → 展开的文件夹被选中时，子行全归它名下，于是连成**一段**、共用一个框。
 */
export function pickOwnerOf(
  row: ArchiveRow,
  top: ReadonlySet<string>,
  parentById: ReadonlyMap<string, string>
): string | undefined {
  if (row.kind !== 'node' || top.size === 0) return undefined
  for (let id: string | undefined = row.node.id; id !== undefined; id = parentById.get(id)) {
    if (top.has(id)) return id
  }
  return undefined
}

/**
 * 一次批量搬运要动哪几条、哪几条动不了。
 *
 * - `ordered`：真要搬的，**顺序就是落到目标层里的顺序**（= 载荷里的顺序 = 用户点选的顺序）。
 * - `cyclic`：目标层在它自己（或它的子孙）里 → `move` 会成环，拒收。
 * - `here`：**已经在目标那一层**的条数。只在「追加到末尾」（落点没给具体某一格）时才算动不了
 *   ——`move` 对同父的行为就是排到最后，而用户要的显然不是这个，所以说一句、不动它；
 *   落点给了具体某一格时它照样要挪过去，那正是「把这批放到这儿」。
 */
export function planPickedMove(
  ids: readonly string[],
  destId: string,
  options: {
    /** 这一条现在挂在谁下面（拿不到 = 不在本栏那份索引里，一律当要搬）。 */
    parentOf(id: string): string | undefined
    /** 目标层的父链（含它自己）——用它挡「搬进自己的子孙」。 */
    destPath: ReadonlySet<string>
    /** 落点给没给**具体某一格**（`here`）；没给 = 追加到那一层末尾。 */
    atPosition: boolean
  }
): {ordered: string[]; here: number; cyclic: number} {
  const ordered: string[] = []
  let here = 0
  let cyclic = 0
  for (const id of ids) {
    if (options.destPath.has(id)) cyclic++
    else if (!options.atPosition && options.parentOf(id) === destId) here++
    else ordered.push(id)
  }
  return {ordered, here, cyclic}
}

/**
 * Shift 点击：把起点到这一行之间的**可见行**全选上。
 * 按**可见顺序**而非层级：用户看到的就是这一列行，展开的子级也在这列里
 * → 「从上面那个文件夹拖到下面那条书签」会连中间隔着的都选上，与资源管理器一致。
 * 起点或终点找不到时退化成「只选终点那一条」。
 */
export function rangeBetween(
  rows: readonly ArchiveRow[],
  fromId: string | undefined,
  toId: string
): string[] {
  const at = (id: string | undefined): number =>
    id === undefined ? -1 : rows.findIndex((row) => row.kind === 'node' && row.node.id === id)
  const from = at(fromId)
  const to = at(toId)
  if (from < 0 || to < 0) return [toId]

  const [start, end] = from <= to ? [from, to] : [to, from]
  const ids: string[] = []
  for (let index = start; index <= end; index++) {
    const row = rows[index]
    if (row?.kind === 'node') ids.push(row.node.id)
  }
  return ids
}
