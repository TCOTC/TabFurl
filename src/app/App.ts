import {createFavoriteFolders} from './FavoriteFolders'
import {FAVORITE_HOST_ID, createTransferPanel, type TransferPanel} from './TransferPanel'
import {q, type AppEvents} from './dom'

/**
 * 主界面：两栏（当前窗口 ↔ 收藏夹），收藏文件夹的 chip 栏在右栏表头下面一行。
 *
 * **页面里没有标题块**：`TabFurl / 窗口 ⇄ 收藏文件夹` 那两行占掉几十像素，
 * 而这个界面本身已经说明了它是谁（左侧是当前窗口、右侧是收藏夹）。
 * 名字改放在**标签页标题**上（`document.title`），切标签页时看得到就够了。
 *
 * **没有标签页切换**：保存与打开是同一个东西的两侧（活会话 ↔ 已落盘的会话），
 * 并排摆在一起才能一眼看清「存到哪、从哪取」。原来分成两个 Tab 时，
 * 保存完想确认或还原它得先切过去——合并的理由与取舍见 `docs/design.md` 七。
 *
 * 这个文件是**唯一的协调者**：两个界面模块互不 import，要跳转、要重算落点都在这里接上。
 */
export function App(): void {
  const host = document.getElementById('root')
  if (!host) return

  document.title = 'TabFurl - 窗口 ⇄ 收藏夹'

  const shell = document.createElement('main')
  // `app--shell`：主界面是一屏应用，只让两栏里的列表自己滚，页面不滚（理由见 base.css）。
  shell.className = 'app app--shell'
  host.replaceChildren(shell)

  const panelsHost = document.createElement('div')
  panelsHost.className = 'panels'
  shell.append(panelsHost)

  /**
   * 面板之间不互相引用，只认这几个事件；具体刷新谁、跳哪里由这里决定。
   *
   * 这里捕获的是 `panel` / `favorites` 这两个变量本身，而它们是在下面才建好的——
   * 回调都在用户操作之后才执行，所以读到的必然是填好的值。
   */
  const events: AppEvents = {
    archiveChanged: async () => {
      await panel.refresh()
    },
    folderChosen: async (folderId) => {
      await panel.navigateTo(folderId)
    },
    favoritesChanged: async () => {
      await favorites.refresh()
      // 收藏变了可能意味着「起点」变了（第一个收藏就是落点），所以面板也要重算一次。
      await panel.refresh()
    }
  }

  const panel: TransferPanel = createTransferPanel(events)
  panelsHost.append(panel.element)

  // chip 栏挂在**右栏表头下面**（由面板留出这个位置）：它决定的是右栏从哪里开始。
  // 「收藏这一层」要知道用户正站在哪，所以这里把一个取值函数递进去——它不反过来读面板的状态。
  const favorites = createFavoriteFolders(events, () => panel.currentFolderId())
  q<HTMLElement>(panel.element, `#${FAVORITE_HOST_ID}`).append(favorites.element)

  void favorites.refresh()
  void panel.refresh()
}
