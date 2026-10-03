import type {BookmarkNode} from '../shared/types'

/**
 * 扁平化之后的一行。**虚拟滚动以行为单位，行与行之间没有嵌套**——层级靠 `depth` 算出的缩进表达。
 * 必须扁平：真实数据全展开是 11003 行 / 11.5 万元素 / 12MB HTML（同步 983ms + 布局 2402ms）。
 */
export interface ArchiveNodeRow {
  kind: 'node'
  node: BookmarkNode
  parentId: string
  depth: number
  /** 在**同一层**里的下标。拖拽算插入位置用它，不必再去 DOM 里数兄弟。 */
  siblingIndex: number
  /** 只有文件夹行有意义。 */
  expanded: boolean
}

/** 展开的空文件夹占一行，否则点开之后什么都没有，看着像「点了没反应」。 */
export interface ArchiveEmptyRow {
  kind: 'empty'
  depth: number
}

export type ArchiveRow = ArchiveNodeRow | ArchiveEmptyRow

/**
 * 当前展开状态下的**可见行**，扁平成数组。
 *
 * 只走树、只产数据、不碰 DOM → 「全部展开」本身是纯内存操作（实测 11003 行约 20ms），
 * 贵的那部分留给窗口渲染。
 */
export function flattenArchive(
  children: readonly BookmarkNode[],
  rootParentId: string,
  expandedIds: ReadonlySet<string>
): ArchiveRow[] {
  const rows: ArchiveRow[] = []
  const walk = (nodes: readonly BookmarkNode[], parentId: string, depth: number): void => {
    nodes.forEach((node, siblingIndex) => {
      const expanded = !node.url && expandedIds.has(node.id)
      rows.push({kind: 'node', node, parentId, depth, siblingIndex, expanded})
      if (!expanded) return
      const kids = node.children ?? []
      if (kids.length === 0) rows.push({kind: 'empty', depth: depth + 1})
      else walk(kids, node.id, depth + 1)
    })
  }
  walk(children, rootParentId, 0)
  return rows
}
