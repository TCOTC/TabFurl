/**
 * 界面模块的共同契约与共用小工具。
 *
 * 模块之间不互相 import，只通过 `AppEvents` 通信，这样拆成几个文件也不会绕成环。
 */

/** 界面里的一块。 */
export interface Panel {
  /** 根元素；由 `App` 负责插进 DOM。 */
  readonly element: HTMLElement
  /** 重新读数据并重渲染。别处改了数据时调用。 */
  refresh(): Promise<void>
}

/** 面板之间互相通知用的回调集合，由 `App` 实现。 */
export interface AppEvents {
  /** 收藏夹树变了：保存、撤销、删除、改名。 */
  archiveChanged(): Promise<void>
  /**
   * 用户点了某个收藏文件夹：让那一栏跳到那一层。导航归面板所有，外部只发意图。
   *
   * **必须带上哪一栏**：F7 之后两栏都是可导航的收藏夹，同一个意图在两栏里落地的地方不一样。
   */
  folderChosen(folderId: string, side: PaneSide): Promise<void>
  /** 收藏列表本身变了（增、删、排序），面板可能要重算落点。 */
  favoritesChanged(): Promise<void>
}

/** 主界面左右两栏。 */
export type PaneSide = 'left' | 'right'

export type StatusKind = 'ok' | 'error'

export function q<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`缺少必需的 DOM 节点：${selector}`)
  return element as T
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function setStatus(
  element: HTMLElement,
  message: string,
  kind: StatusKind
): void {
  if (!message) {
    element.hidden = true
    element.textContent = ''
    return
  }
  element.hidden = false
  element.className = `status status--${kind}`
  element.textContent = message
}

/**
 * 建界面外壳。
 *
 * **不再带 `role="tabpanel"`**：那是「顶部标签页切换」时代的语义，
 * 现在只有一个两栏界面，标成 tabpanel 反而会指向一个并不存在的 `tab-*` 元素。
 */
export function createPanelElement(id: string): HTMLElement {
  const element = document.createElement('section')
  element.className = 'panel'
  element.id = `panel-${id}`
  return element
}

/**
 * 拖动载荷来源。用自定义类型而非 `text/plain`，与「从网页拖来的链接」（只带 `text/uri-list`）分开。
 * `selection` = 一次拖好几条收藏夹条目；id 是**规约过的顶层项**，
 * 否则同一个文件夹会被搬两次（子树已经跟着走了）。
 */
export type DragPayload =
  | {kind: 'tab'; tabId: number}
  | {kind: 'group'; index: number}
  /**
   * 多选的一批标签（窗口栏）。`tabIds` 按**窗口顺序**给，搬动时就用这个顺序。
   *
   * `groupKeys` 是这一批里**整组被选中**的分组的键（`groupPickKey()`）。只有它里面的分组
   * 存进收藏夹时才写成文件夹；组内标签**逐枚选中**时即使一枚不落也不建文件夹。
   *
   * 与 `selection`（收藏夹节点 id）分开：两者 id 混不到一起，而 `windowTabsFor()` /
   * `childrenFor()` 都要按 tabId 去 `windowChildren` 里找。
   */
  | {kind: 'tabs'; tabIds: number[]; groupKeys?: string[]}
  | {kind: 'bookmark'; id: string}
  | {kind: 'folder'; id: string}
  | {kind: 'separator'; id: string}
  | {kind: 'selection'; ids: string[]}

/** 一行内部的落点。上缘 = 插到前面，下缘 = 插到后面，中间 = **进入**。 */
export type DropSpot = 'before' | 'into' | 'after'

/**
 * 收藏夹那一栏的落点：`into` = 进某个子文件夹，`here` = 插到某一层的某个下标。
 * **`here` 必须带 `parentId`**：行内展开后同一份可见清单混着好几层，而虚拟滚动下视口外的行不存在
 * → 只给下标（哪怕去 DOM 数兄弟）都会算出错的层内下标，静默插到别的地方。
 */
export type ArchiveDrop =
  | {kind: 'into'; folderId: string}
  | {kind: 'here'; parentId: string; index: number; after: boolean}

/**
 * 行内落点三分法：上缘 = 插到它前面，下缘 = 插到它后面，中间 = **进入**它。
 * 「进入」只对能装东西的行成立（文件夹行、标签分组行）。两栏共用：这套手势必须一致，
 * 否则同一个动作会因为「偏了 3 像素」在两栏里落到不同的意思上。
 */
export function spotIn(row: HTMLElement, clientY: number, canEnter: boolean): DropSpot {
  const rect = row.getBoundingClientRect()
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5
  if (!canEnter) return ratio < 0.5 ? 'before' : 'after'
  if (ratio < 0.3) return 'before'
  if (ratio > 0.7) return 'after'
  return 'into'
}

/**
 * 「落在末尾」的提示：线画在**最后一行**的下缘，不把整栏高亮（写入总是**追加到末尾**）。
 * 只有列表真空才退化成整栏高亮。**不能用 `:last-of-type`**：它按元素类型（`li`）算，
 * 而左栏最后一行的父级是 `.kids` 里的 `ul` → 匹配不到就掉回整栏高亮那条错路。
 */
export function markEndDrop(list: HTMLElement, pane: HTMLElement): void {
  const rows = list.querySelectorAll<HTMLElement>('[data-drop-row]')
  const last = rows[rows.length - 1]
  if (last) last.classList.add('is-drop-after')
  else pane.classList.add('is-drop-active')
}


