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

/** 勾选的三种状态。 */
export type TriState = 'all' | 'some' | 'none'

/**
 * 由「保留数 / 总数」推出三态。
 *
 * `total` 为 0（没有可勾的项）时一律算 `none`：此时勾选框应当不可用，而不是显示成「全选」。
 */
export function triState(kept: number, total: number): TriState {
  if (total <= 0 || kept <= 0) return 'none'
  return kept >= total ? 'all' : 'some'
}

/**
 * 点一下三态勾选框该变成什么。
 *
 * 「全选」→ 全不选（清空）；「部分」「全不选」→ 全选。
 * 这是 Windows 资源管理器一类界面的惯例：部分选择时点击的意图是「干脆全要」。
 *
 * 之所以不读 `input.checked` 的取反结果：原生 indeterminate 被点击时只是把 `checked`
 * 取反，在「部分」状态下（checked 为真）会变成「全不选」，与惯例相反。
 */
export function nextSelectAll(state: TriState): boolean {
  return state !== 'all'
}

/** 顶层三态勾选框。 */
export interface SelectAllControl {
  readonly input: HTMLInputElement
  /** 用「保留数 / 总数」刷新三态与文案；`filtered` 表示列表正处于搜索过滤状态。 */
  update(kept: number, total: number, filtered?: boolean): void
}

/**
 * 建一个顶层三态勾选框，追加到 `host` 里。
 *
 * 原生 `<input type="checkbox">` 就能表示三态——`indeterminate` 是 **DOM 属性**，
 * 所以不能写进 `innerHTML`，必须建好元素后用 JS 设置（这也常被误认为「原生不支持」）。
 */
export function createSelectAll(
  host: HTMLElement,
  options: {
    /** 由保留数、总数、以及「列表是否在过滤中」生成文案。 */
    describe(kept: number, total: number, filtered: boolean): string
    /** 用户点击后的意图：true = 全选，false = 全不选。 */
    onChange(selectAll: boolean): void
  }
): SelectAllControl {
  const label = document.createElement('label')
  label.className = 'select-all'

  const input = document.createElement('input')
  input.type = 'checkbox'

  const text = document.createElement('span')

  label.append(input, text)
  host.append(label)

  let state: TriState = 'none'

  input.addEventListener('change', () => {
    options.onChange(nextSelectAll(state))
  })

  return {
    input,
    update(kept: number, total: number, filtered = false): void {
      state = triState(kept, total)
      input.checked = state !== 'none'
      input.indeterminate = state === 'some'
      input.disabled = total <= 0
      text.textContent = options.describe(kept, total, filtered)
    }
  }
}

/**
 * 拖动来源。
 *
 * 用它而不是 `text/plain` 区分「本项目内部的拖动」与「从网页拖来的链接」：
 * 后者只带 `text/uri-list`，处理方式不同（按网址存成书签，而不是按键去找节点）。
 */
export type DragPayload =
  | {kind: 'tab'; tabId: number}
  | {kind: 'group'; index: number}
  | {kind: 'bookmark'; id: string}
  | {kind: 'folder'; id: string}
  | {kind: 'separator'; id: string}

/** 一行内部的落点。上缘 = 插到前面，下缘 = 插到后面，中间 = **进入**。 */
export type DropSpot = 'before' | 'into' | 'after'

/**
 * 收藏夹那一栏的落点。
 *
 * `into` 是进某个子文件夹；`here` 是插到某一层的某个下标。
 *
 * **`here` 必须带上 `parentId`**：行内展开之后，同一份可见清单里混着好几层的行，
 * 而虚拟滚动之下视口外的行根本不存在——只给下标（哪怕去 DOM 里数兄弟）都会算出
 * 一个错的层内下标，于是静默插到别的地方去。
 */
export type ArchiveDrop =
  | {kind: 'into'; folderId: string}
  | {kind: 'here'; parentId: string; index: number; after: boolean}

/**
 * 行内落点三分法：上缘 = 插到它前面，下缘 = 插到它后面，中间 = **进入**它。
 *
 * 「进入」只对能装东西的行成立（文件夹行、标签分组行）。三分法让一行的三个位置正好对应
 * 三种意图，不需要另加「拖到这里就进去」的按钮或悬停展开。
 *
 * 两栏共用（左边是标签行、右边是收藏夹行）：这套手势必须一致，否则同一个动作在两栏里
 * 会因为「偏了 3 像素」而落到不同的意思上。
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
 * 「落在末尾」的提示：线画在**最后一行**的下缘，而不是把整栏高亮。
 *
 * 整栏高亮看起来像「丢进这一栏里，具体到哪儿我不知道」，而实际上写入总是**追加到末尾**，
 * 所以末尾那条线说的才是真话。只有列表真的是空的（没有任何行）才退化成整栏高亮。
 *
 * 行用 `querySelectorAll('[data-drop-row]')` 取全部（含分组 / 文件夹内部的），文档顺序即视觉顺序；
 * 不能用 `:last-of-type`：那是按元素类型（`li`）算的，左栏最后一行的父级是 `.kids` 里的 `ul`，
 * 匹配不到就会掉到「整栏高亮」那条错路上去。
 */
export function markEndDrop(list: HTMLElement, pane: HTMLElement): void {
  const rows = list.querySelectorAll<HTMLElement>('[data-drop-row]')
  const last = rows[rows.length - 1]
  if (last) last.classList.add('is-drop-after')
  else pane.classList.add('is-drop-active')
}

/**
 * 点整行 = 点它的勾选框。
 *
 * 实现上是**替用户点那个复选框**，而不是另写一份勾选逻辑：三态（分组行与文件夹行）的
 * 「全选 ↔ 全不选」意图判定只在 `change` 处理器里写了一次，再写一份必然分叉。
 *
 * 勾选框、行内按钮、重命名输入框各有自己的语义，落在它们身上不算「点行」。
 */
export function toggleRowFromClick(list: HTMLElement, event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('input, button, a')) return
  const row = target.closest<HTMLElement>('[data-row]')
  if (!row || !list.contains(row)) return
  row.querySelector<HTMLInputElement>('input[type=checkbox]')?.click()
}
