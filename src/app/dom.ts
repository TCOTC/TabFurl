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
  /** 用户点了某个收藏文件夹：让右栏跳到那一层。导航归面板所有，外部只发意图。 */
  folderChosen(folderId: string): Promise<void>
  /** 收藏列表本身变了（增、删、排序），面板可能要重算落点。 */
  favoritesChanged(): Promise<void>
}

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
