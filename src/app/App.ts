import {createFavoriteBar, createFavoriteStore} from './FavoriteFolders'
import {
  FAVORITE_HOST_ID,
  LEFT_FAVORITE_HOST_ID,
  createTransferPanel,
  type TransferPanel
} from './TransferPanel'
import {q, type AppEvents} from './dom'

/**
 * 主界面：两栏（窗口 / 收藏夹 ⇄ 收藏夹），两条 chip 栏各挂在两栏表头上。
 *
 * **页面里没有标题块**（那两行占掉几十像素，而界面本身已说明它是谁）→ 名字放在标签页标题上（`document.title`）。
 * **没有标签页切换**：保存与打开是同一个东西的两侧，并排摆着才看得清「存到哪、从哪取」。
 *
 * 这个文件是**唯一的协调者**：界面模块互不 import，要跳转、要重算落点都在这里接上。
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
   * 回调里引用的是下面才建好的 `panel`——回调都在用户操作之后才执行，那时它早已填好。
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
   * 收藏文件夹的 chip 栏：**一份状态、两块视图**。两栏各有一条，说的是同一份收藏、同一个顺序
   *（在一条上排序，另一条跟着变）。各自不同的只有「我这一栏正站在哪」→ 两个取值函数分别递进去。
   * 状态那份不碰 DOM（只读写存储并叫一声），重画交给视图 → 两条视图不需要互相认识。
   */
  const favorites = createFavoriteStore(events)
  const rightBar = createFavoriteBar(favorites, events, 'right', () => panel.currentFolderId())
  const leftBar = createFavoriteBar(favorites, events, 'left', () => panel.leftFolderId())
  q<HTMLElement>(panel.element, `#${FAVORITE_HOST_ID}`).append(rightBar.element)
  q<HTMLElement>(panel.element, `#${LEFT_FAVORITE_HOST_ID}`).append(leftBar.element)

  void favorites.load()
  void panel.refresh()
}
