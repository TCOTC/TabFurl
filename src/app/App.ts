import {createDefaultFolderPicker} from './DefaultFolderPicker'
import {createTransferPanel} from './TransferPanel'
import {q, type AppEvents, type Panel} from './dom'

/**
 * 主界面：工具栏一行是默认展示文件夹，下面是「保存 / 打开」两栏。
 *
 * **没有标签页切换**：保存与打开是同一个东西的两侧（活会话 ↔ 已落盘的会话），
 * 并排摆在一起才能一眼看清「存到哪、从哪取」。原来分成两个 Tab 时，
 * 保存完想确认或还原它得先切过去——合并的理由与取舍见 `docs/design.md` 七。
 */
const SHELL_TEMPLATE = `
  <header class="app__header">
    <h1 class="app__title">TabFurl</h1>
    <p class="app__subtitle">窗口 ⇄ 收藏文件夹</p>
  </header>
  <div class="topbar"></div>
`

export function App(): void {
  const host = document.getElementById('root')
  if (!host) return

  const shell = document.createElement('main')
  // `app--shell`：主界面是一屏应用，只让两栏里的列表自己滚，页面不滚（理由见 base.css）。
  shell.className = 'app app--shell'
  shell.innerHTML = SHELL_TEMPLATE
  host.replaceChildren(shell)

  const topbar = q<HTMLDivElement>(shell, '.topbar')
  const panelsHost = document.createElement('div')
  panelsHost.className = 'panels'
  shell.append(panelsHost)

  /**
   * 面板之间不互相引用，只认这两个事件；具体刷新谁由这里决定。
   *
   * 这里捕获的是 `panel` / `rootPicker` 这两个变量本身，而它们是在下面才建好的——
   * 回调都在用户操作之后才执行，所以读到的必然是填好的值。
   */
  const events: AppEvents = {
    archiveChanged: async () => {
      await panel.refresh()
    },
    settingsChanged: async () => {
      await folderPicker.refresh()
      await panel.refresh()
    }
  }

  const panel: Panel = createTransferPanel(events)
  panelsHost.append(panel.element)

  // 默认展示文件夹不属于任何一栏，挂在外壳里：它决定右栏从哪里开始。
  const folderPicker = createDefaultFolderPicker(events)
  topbar.append(folderPicker.element)

  void folderPicker.refresh()
  void panel.refresh()
}
