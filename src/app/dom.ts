/**
 * 三个标签页的共同契约与共用小工具。
 *
 * 面板之间不互相 import，只通过 `AppEvents` 通信，这样拆成三个文件也不会绕成环。
 */

/** 一个标签页面板。 */
export interface Panel {
  /** 面板根元素；由 `App` 负责插进 DOM 与显隐。 */
  readonly element: HTMLElement
  /** 重新读数据并重渲染。切到该标签页、或别处改了数据时调用。 */
  refresh(): Promise<void>
}

/** 面板之间互相通知用的回调集合，由 `App` 实现。 */
export interface AppEvents {
  /** 存档树变了：保存、撤销、删除、改名。 */
  archiveChanged(): Promise<void>
  /** 设置变了：存档根、会话命名方式、还原行为。 */
  settingsChanged(): Promise<void>
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
  element: HTMLParagraphElement,
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

/** 建面板外壳。id 与 aria 指向由这里统一拼，免得三处写法不一致。 */
export function createPanelElement(id: string): HTMLElement {
  const element = document.createElement('section')
  element.className = 'panel'
  element.id = `panel-${id}`
  element.setAttribute('role', 'tabpanel')
  element.setAttribute('aria-labelledby', `tab-${id}`)
  return element
}
