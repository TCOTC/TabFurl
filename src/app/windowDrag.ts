import type {WindowChild} from '../shared/capture'
import type {TabSnapshot} from '../shared/types'
import type {DragPayload} from './dom'

/** 左栏的落点。`end` 表示落在末尾（空白处），那时归组看**最后一行**属于哪个分组。 */
export type WindowDrop =
  | {kind: 'tab'; anchorIndex: number; after: boolean; groupId?: number}
  | {kind: 'end'; groupId?: number}

/**
 * 从被拖元素的 `dataset` 解析出载荷。
 *
 * `dragover` 里读不到 `data`（只有 `types`），所以拖动一旦开始就把载荷记在变量里，
 * 这一份解析只在 `dragstart` 用一次。
 */
export function payloadFromDataset(dataset: DOMStringMap): DragPayload | undefined {
  const tabId = dataset.dragTab
  if (tabId !== undefined) return {kind: 'tab', tabId: Number(tabId)}
  const group = dataset.dragGroup
  if (group !== undefined) return {kind: 'group', index: Number(group)}
  const bookmark = dataset.dragBookmark
  if (bookmark !== undefined) return {kind: 'bookmark', id: bookmark}
  const folder = dataset.dragFolder
  if (folder !== undefined) return {kind: 'folder', id: folder}
  const separator = dataset.dragSeparator
  if (separator !== undefined) return {kind: 'separator', id: separator}
  return undefined
}

/** 这条载荷指向哪个节点（只有收藏夹那三类有）。用于判「拖到自己那一行上了」。 */
export function payloadNodeId(payload: DragPayload | undefined): string | undefined {
  if (!payload) return undefined
  return payload.kind === 'bookmark' || payload.kind === 'folder' || payload.kind === 'separator'
    ? payload.id
    : undefined
}

/**
 * 载荷 → 要写进书签的子级。
 *
 * 组内的标签单独拖出来时只写**这一枚**（散装书签），而不是把整组建一遍。
 */
export function childrenFor(payload: DragPayload, children: readonly WindowChild[]): WindowChild[] {
  if (payload.kind === 'group') {
    const child = children[payload.index]
    return child?.kind === 'group' ? [child] : []
  }
  if (payload.kind !== 'tab') return []

  for (const child of children) {
    if (child.kind === 'tab') {
      if (child.tab.tabId === payload.tabId) return [child]
      continue
    }
    const hit = child.tabs.find((tab) => tab.tabId === payload.tabId)
    if (hit) return [{kind: 'tab', tab: hit}]
  }
  return []
}

/** 载荷在窗口里的**全部**标签（拖一个分组就是整组），用来算插入位置与 move 的入参。 */
export function windowTabsFor(payload: DragPayload, children: readonly WindowChild[]): TabSnapshot[] {
  if (payload.kind === 'group') {
    const child = children[payload.index]
    return child?.kind === 'group' ? [...child.tabs] : []
  }
  if (payload.kind !== 'tab') return []
  for (const child of children) {
    if (child.kind === 'tab' && child.tab.tabId === payload.tabId) return [child.tab]
    if (child.kind === 'group') {
      const hit = child.tabs.find((tab) => tab.tabId === payload.tabId)
      if (hit) return [hit]
    }
  }
  return []
}

/**
 * 「插到第 anchor 枚标签前/后」对应的最终下标。
 *
 * `dragged` 是那几枚**当前**的下标：它们会先从数组里摘出去 → 锚点之前的那几枚都会让它前移一格。
 * （`tabs.move` 的 index 是**移动之后**的位置，这是那条语义差异的落点。）
 */
export function anchorInsertIndex(anchor: number, after: boolean, dragged: readonly number[]): number {
  const removedBefore = dragged.filter((index) => index < anchor).length
  const anchorInRest = anchor - removedBefore
  return after ? anchorInRest + 1 : anchorInRest
}

/**
 * 这次拖动该传给 `tabs.move` 的 index；返回 `undefined` = **原地不动**，调用方直接收工。
 *
 * - **锚点就是被拖的那几枚之一 → 原地不动**：`anchorInsertIndex` 那个式子只对
 *   「锚点不在 dragged 里」成立，而拖分组时锚点常常就是组内某一枚（单枚与分组共用这一刀）。
 * - 落在末尾：给**最后一个下标**（`totalTabs - 1`）。`tabs.move` 把越界 index 钳到 `count - 1`，
 *   而多枚是「逐个搬、每搬一枚 index + 1」→ 写「总数 - 自身枚数」会差几格。
 * - 其余交给 `anchorInsertIndex`（它会减掉锚点前那几枚）。
 *
 * `totalTabs` 是**窗口里的真实标签数**（含被过滤掉的内部页面），否则「最后一个下标」不是最后一个。
 * 参数只要 `index`：搬分组时给的是浏览器那头的真实成员，不是 `TabSnapshot`。
 */
export function moveIndexFor(
  drop: WindowDrop,
  dragged: readonly {index: number}[],
  totalTabs: number
): number | undefined {
  if (dragged.length === 0) return undefined
  if (drop.kind === 'tab' && dragged.some((tab) => tab.index === drop.anchorIndex)) {
    return undefined
  }
  if (drop.kind === 'end') return totalTabs - 1
  return anchorInsertIndex(drop.anchorIndex, drop.after, dragged.map((tab) => tab.index))
}
