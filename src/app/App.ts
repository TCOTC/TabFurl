import {createDefaultFolderPicker} from './DefaultFolderPicker'
import {FOLDER_PICK_HOST_ID, createTransferPanel} from './TransferPanel'
import {q, type AppEvents, type Panel} from './dom'

/**
 * 主界面：两栏（当前窗口 ↔ 收藏夹），默认展示文件夹选择器在右栏表头里。
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
`

export function App(): void {
  const host = document.getElementById('root')
  if (!host) return

  const shell = document.createElement('main')
  // `app--shell`：主界面是一屏应用，只让两栏里的列表自己滚，页面不滚（理由见 base.css）。
  shell.className = 'app app--shell'
  shell.innerHTML = SHELL_TEMPLATE
  host.replaceChildren(shell)

  const panelsHost = document.createElement('div')
  panelsHost.className = 'panels'
  shell.append(panelsHost)

  /**
   * 面板之间不互相引用，只认这两个事件；具体刷新谁由这里决定。
   *
   * 这里捕获的是 `panel` / `folderPicker` 这两个变量本身，而它们是在下面才建好的——
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

  const folderPicker = createDefaultFolderPicker(events)
  // 选择器挂在**右栏表头**里（面板只提供那个位置）：它决定的是右栏从哪里开始，
  // 放在页面顶栏上离它要影响的那一栏太远。
  q<HTMLElement>(panel.element, `#${FOLDER_PICK_HOST_ID}`).append(folderPicker.element)

  void folderPicker.refresh()
  void panel.refresh()
}
