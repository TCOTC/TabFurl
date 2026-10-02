import {createArchivePanel} from './ArchivePanel'
import {createArchiveRootPicker} from './ArchiveRootPicker'
import {createCapturePanel} from './CapturePanel'
import {q, type AppEvents, type Panel} from './dom'

/**
 * 顶部标签页。可以用 `pages/app.html#archive` 这样的 hash 直接定位到某一个。
 *
 * 没有「设置」页：唯一需要配置的存档位置就在标签栏旁边（见 `ArchiveRootPicker`），
 * 其余的偏好已经在下面两块里改成了直接操作——比如还原的去向是按钮，不是一个全局选项。
 */
const TABS = [
  {id: 'capture', label: '保存'},
  {id: 'archive', label: '存档'}
] as const

export type TabId = (typeof TABS)[number]['id']

function isTabId(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value)
}

const SHELL_TEMPLATE = `
  <header class="app__header">
    <h1 class="app__title">TabFurl</h1>
    <p class="app__subtitle">窗口 ⇄ 收藏文件夹</p>
  </header>
  <div class="topbar">
    <div class="tabs" role="tablist" aria-label="功能区">
      ${TABS.map(
        (tab) => `
        <button type="button" class="tab" role="tab" id="tab-${tab.id}" data-tab="${tab.id}"
                aria-controls="panel-${tab.id}" aria-selected="false" tabindex="-1">${tab.label}</button>`
      ).join('')}
    </div>
  </div>
  <div class="panels"></div>
`

export function App(): void {
  const host = document.getElementById('root')
  if (!host) return

  const shell = document.createElement('main')
  shell.className = 'app'
  shell.innerHTML = SHELL_TEMPLATE
  host.replaceChildren(shell)

  const tablist = q<HTMLDivElement>(shell, '.tabs')
  const topbar = q<HTMLDivElement>(shell, '.topbar')
  const panelsHost = q<HTMLDivElement>(shell, '.panels')

  const panels = new Map<TabId, Panel>()

  /**
   * 面板之间不互相引用，只认下面这两个事件；具体刷新谁由这里决定。
   *
   * 这里捕获的是 `panels` 这个 Map 本身，而面板是在下面才建好的——回调都在用户
   * 操作之后才执行，所以读到的必然是填好的 Map。
   */
  async function refreshTabs(...ids: readonly TabId[]): Promise<void> {
    await Promise.all(ids.map((id) => panels.get(id)!.refresh()))
  }

  const events: AppEvents = {
    archiveChanged: () => refreshTabs('archive', 'capture'),
    settingsChanged: () => refreshTabs('capture', 'archive')
  }

  panels.set('capture', createCapturePanel(events))
  panels.set('archive', createArchivePanel(events))

  for (const tab of TABS) panels.get(tab.id)!.element.hidden = true
  panelsHost.append(...[...panels.values()].map((panel) => panel.element))

  // 存档位置不属于任何一块面板，所以挂在外壳里、标签栏的右边：两块都看得见它。
  const rootPicker = createArchiveRootPicker(events)
  topbar.append(rootPicker.element)
  void rootPicker.refresh()

  let active: TabId = readInitialTab()

  function readInitialTab(): TabId {
    const fromHash = location.hash.replace(/^#/, '')
    return isTabId(fromHash) ? fromHash : 'capture'
  }

  function selectTab(id: TabId, options: {focus?: boolean} = {}): void {
    active = id

    for (const tab of TABS) {
      const selected = tab.id === id
      const button = q<HTMLButtonElement>(shell, `#tab-${tab.id}`)
      button.setAttribute('aria-selected', String(selected))
      // 只有当前标签页在 Tab 键序列里，方向键才在几个标签之间移动（ARIA 的标准做法）。
      button.tabIndex = selected ? 0 : -1
      panels.get(tab.id)!.element.hidden = !selected
    }

    if (options.focus) q<HTMLButtonElement>(shell, `#tab-${id}`).focus()

    // 界面状态而已，不该在浏览器历史里堆出一串「后退」。
    history.replaceState(null, '', `#${id}`)

    void panels.get(id)!.refresh()
  }

  tablist.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]')
    const id = button?.dataset.tab
    if (id && isTabId(id)) selectTab(id)
  })

  tablist.addEventListener('keydown', (event) => {
    const index = TABS.findIndex((tab) => tab.id === active)
    let next: number

    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return

    event.preventDefault()
    selectTab(TABS[next].id, {focus: true})
  })

  // 在地址栏里改 hash 时跟上，免得界面停在旧标签页而 URL 已经指到另一个。
  // selectTab 用的是 replaceState，不会反过来触发这个监听。
  window.addEventListener('hashchange', () => {
    const id = readInitialTab()
    if (id !== active) selectTab(id)
  })

  selectTab(active)
}
