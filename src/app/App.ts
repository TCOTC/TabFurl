import {createFavoriteBar, createFavoriteStore} from './FavoriteFolders'
import {
  FAVORITE_HOST_ID,
  LEFT_FAVORITE_HOST_ID,
  createTransferPanel,
  type TransferPanel
} from './TransferPanel'
import {q, type AppEvents} from './dom'

/**
 * 主界面：两栏（窗口 / 收藏夹 ⇄ 收藏夹），两条 chip 栏分别挂在两栏表头上。
 *
 * **页面里没有标题块**：`TabFurl / 窗口 ⇄ 收藏文件夹` 那两行占掉几十像素，
 * 而这个界面本身已经说明了它是谁（左栏是窗口或另一个收藏夹、右栏是收藏夹）。
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
   * 这里捕获的是 `panel` 这个变量本身，而它是在下面才建好的——回调都在用户操作之后才执行，
   * 所以读到的必然是填好的值。
   */
  const events: AppEvents = {
    archiveChanged: async () => {
      await panel.refresh()
    },
    folderChosen: async (folderId, side) => {
      // 点哪一栏的 chip 就跳哪一栏：同一个「跳到这一层」的意图，有两个落点。
      if (side === 'left') await panel.navigateToLeft(folderId)
      else await panel.navigateTo(folderId)
    },
    favoritesChanged: async () => {
      // 收藏变了可能意味着「起点」变了（第一个收藏就是落点），所以两边都要重算一次：
      // 状态那边读存储并通知两块视图，面板那边重新决定落在哪一层。
      await favorites.load()
      await panel.refresh()
    }
  }

  const panel: TransferPanel = createTransferPanel(events)
  panelsHost.append(panel.element)

  /**
   * 收藏文件夹的 chip 栏：**一份状态、两块视图**。
   *
   * 两栏各有一条（左栏那条只在它看着收藏夹时露面），但说的是同一份收藏、同一个顺序——
   * 在一条上排序，另一条跟着变。各自不同的只有「我这一栏正站在哪」，
   * 所以这里把两个取值函数分别递进去（那是**查询**，不是事件）。
   *
   * 状态那份东西不碰 DOM，只负责读写存储并叫一声；重画交给视图。
   * 两条视图因此不需要互相认识，也不需要知道对方存在。
   */
  const favorites = createFavoriteStore(events)
  const rightBar = createFavoriteBar(favorites, events, 'right', () => panel.currentFolderId())
  const leftBar = createFavoriteBar(favorites, events, 'left', () => panel.leftFolderId())
  q<HTMLElement>(panel.element, `#${FAVORITE_HOST_ID}`).append(rightBar.element)
  q<HTMLElement>(panel.element, `#${LEFT_FAVORITE_HOST_ID}`).append(leftBar.element)

  void favorites.load()
  void panel.refresh()
}
