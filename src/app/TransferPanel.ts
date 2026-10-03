import {createBookmark, getNodePath, removeSubTree} from '../shared/bookmarks'
import {
  planWindowChildren,
  snapshotCurrentWindow,
  writeChildren,
  type WindowChild
} from '../shared/capture'
import {discardCommittedTabs, restoreFolder} from '../shared/restore'
import {loadSettings} from '../shared/settings'
import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {RestoreOptions, TabSnapshot} from '../shared/types'
import {
  createPanelElement,
  createSelectAll,
  errorText,
  markEndDrop,
  nextSelectAll,
  q,
  setStatus,
  spotIn,
  toggleRowFromClick,
  triState,
  type AppEvents,
  type ArchiveDrop,
  type DragPayload,
  type MoveItem,
  type Panel
} from './dom'
import {createArchivePane, type ArchivePane} from './ArchivePane'
import {FAVICON_BASE, OPEN_MANAGER_ICON, PIN_ICON, REFRESH_ICON, plusIcon} from './icons'

/**
 * 内建拖拽载荷的类型名。
 *
 * 用它而不是 `text/plain` 是为了区分「本项目内部的拖动」与「从网页拖来的链接」：
 * 后者只带 `text/uri-list`，处理方式不同（按网址存成书签，而不是按键找书签）。
 */
const DRAG_TYPE = 'application/x-tabfurl'

type RestoreKind = 'newWindow' | 'currentWindow'

/**
 * 左栏看什么：当前窗口的标签，还是另一个收藏夹。
 *
 * 两档互斥、又没有「一次点两个」的说法，所以界面上是一枚分段控件而不是两个按钮。
 */
type Mode = 'window' | 'archive'

/** 左栏的落点。`end` 表示落在末尾（空白处），那时归组看**最后一行**属于哪个分组。 */
type WindowDrop =
  | {kind: 'tab'; anchorIndex: number; after: boolean; groupId?: number}
  | {kind: 'end'; groupId?: number}

/**
 * 中间按钮上的计数。
 *
 * 括号用**半角并留一个空格**：全角括号在中文字体里占满一格，与数字之间看着空得发虚。
 * 位数变化带来的宽度差由按钮自己的 `min-width` 吃掉（见 base.css 的 `--move-btn-min`），
 * 不在这里预留。
 */
function countLabel(text: string, count: number): string {
  return `${text} (${count})`
}

/**
 * 收藏文件夹 chip 栏的挂载点 id。
 *
 * `App` 用它把 chip 栏放进右栏表头**下面那一行**，而 `TransferPanel` 只管留出这个位置——
 * 这样两个界面模块仍然互不 import（面板不知道挂进来的会是什么）。
 *
 * 位置必须在 `TEMPLATE` **之前**：模板字面量在求值时就会读它。
 */
export const FAVORITE_HOST_ID = 'favorite-host'

/**
 * 左栏那枚两档控件的挂载点 id。
 *
 * `App` 用它把**左栏**的 chip 栏放进左栏表头（与右栏那条是同一份数据的两块视图）。
 * 与 `FAVORITE_HOST_ID` 同理：面板只留位置，两个界面模块仍然互不 import。
 */
export const LEFT_FAVORITE_HOST_ID = 'left-favorite-host'

/**
 * 一个收藏夹栏的标记——**不含表头**（表头两栏不一样：右栏是标题 + chip 栏，左栏是两档控件）。
 *
 * 右栏本来就是这一套，F7 之后**左栏也能切成收藏夹**，所以它必须能被生成两份，而不是复制一遍 HTML。
 * 两栏的 `id` 用前缀区分（`archive` / `left-archive`）：两个 `ArchivePane` 住在同一份 DOM 里，
 * 而 `ArchivePane` 是按 id 找元素的——id 重了就会各自找到对方的东西，而且那种错很安静
 * （一边勾选、另一边跟着变）。
 *
 * 必须定义在 `TEMPLATE` **之前**：模板字面量在求值时就会调用它。
 */
function archiveColumnMarkup(prefix: string): string {
  return `
      <div class="row row--compact" id="${prefix}-all-host"></div>
      <div class="box" data-drop-pane="archive">
        <!--
          当前位置与导航按钮都在**列表框里面**的顶部，而且粘住不滚走：
          它们与列表是同一份内容的两个视角（「我在哪」与「这里有什么」），
          摆在一起才不用在两个区域之间来回对；粘住是因为列表可以很长，
          滚到一半时退路不该消失。

          退路就是面包屑本身，所以旁边不再单放一个「上一层」按钮：一样东西两个入口，
          总有一个会先被人遗忘。按钮组推到最右，它们与「往哪走」无关。
        -->
        <div class="box__top">
          <div class="box__bar">
            <nav class="path" id="${prefix}-path" aria-label="当前所在的收藏夹位置"></nav>
            <div class="row row--compact">
              <button type="button" class="btn btn--ghost btn--sm" id="${prefix}-expand-all-btn">全部展开</button>
              <button type="button" class="btn btn--ghost btn--sm" id="${prefix}-new-folder-btn">＋ 新建文件夹</button>
              <button type="button" class="btn btn--ghost btn--sm" id="${prefix}-new-separator-btn"
                      title="在当前位置插一条分隔线（竖线，给横向排列的书签栏用）">＋ 分隔线</button>
              <button type="button" class="btn btn--ghost btn--sm" id="${prefix}-new-gap-btn"
                      title="在当前位置插一条间隔（横线，给竖向排列的列表用）">＋ 间隔</button>
              <!-- 它挂在全选框那一行的右端（在刷新按钮左边），见 makeRefreshButton 附近。 -->
              <button type="button" class="btn btn--ghost btn--icon" id="${prefix}-open-root-btn"
                      title="在浏览器自带的书签管理器里打开这一层"
                      aria-label="在浏览器自带的书签管理器里打开这一层">${OPEN_MANAGER_ICON}</button>
            </div>
          </div>
          <!-- 在书签树根上时写入入口会是灰的，用一句话说明为何以及怎么退出去。 -->
          <p class="box__note" id="${prefix}-note" hidden></p>
        </div>
        <!--
          先放几块骨架：数据是异步读来的（设置 + 标签 + 书签树三处），在它们回来之前列表是空的，
          而「空列表」与「真的没有内容」长得一模一样——用户看到的是「先空一下、内容再蹦出来」。
          骨架把这一段变成「正在读」（尺寸见 app.css 的 .skeleton）。
        -->
        <ul class="list" id="${prefix}-list">
          <li class="skeleton" aria-hidden="true"></li>
          <li class="skeleton" aria-hidden="true"></li>
          <li class="skeleton" aria-hidden="true"></li>
          <li class="skeleton" aria-hidden="true"></li>
        </ul>
      </div>
  `
}

const TEMPLATE = `
  <div class="split">
    <section class="col" id="left-col">
      <header class="col__head">
        <!--
          左栏看什么，是**两档**而不是两个按钮：这两个东西互斥、又没有「一次点两个」的说法，
          所以做成一枚分段控件（同一件事的两种取值），而不是两条命令。

          位置就在这一栏表头、顶掉原来那个标题：它改的就是这一栏装什么，
          摆在别处都要用户先建立一次「这点的是左边」的心智映射；
          而右栏同一个位置放的是 chip 栏，于是两栏表头从此对称——
          左边是「这一栏看什么」，右边是「这一栏从哪开始」。

          **不新增一行高度**：这个位置本来就空着一大片（理由见 docs/design.md 七）。
        -->
        <div class="modes" role="group" aria-label="左栏显示什么">
          <button type="button" class="mode is-active" data-mode="window" aria-pressed="true">当前窗口 <span class="badge" id="window-count">0</span></button>
          <button type="button" class="mode" data-mode="archive" aria-pressed="false">收藏夹 <span class="badge" id="left-archive-count">0</span></button>
        </div>
        <!--
          左栏的 chip 栏只在这一栏看着收藏夹时出现（看窗口时它没地方可跳）。
          与右栏那条是**同一份数据的两块视图**：在任一栏加/删/排序，两条一起变；
          点某一栏的 chip 只跳那一栏。理由见 docs/design.md 七。
        -->
        <div class="favs-host" id="${LEFT_FAVORITE_HOST_ID}" hidden></div>
      </header>
      <div class="left-view" id="window-view">
        <div class="row row--compact" id="window-all-host"></div>
        <div class="box" data-drop-pane="window">
          <!--
            先放几块骨架：数据是异步读来的（设置 + 标签 + 书签树三处），在它们回来之前列表是空的，
            而「空列表」与「真的没有标签」长得一模一样——用户看到的是「先空一下、内容再蹦出来」。
            骨架把这一段变成「正在读」（尺寸见 app.css 的 .skeleton）。
          -->
          <ul class="list" id="window-list">
            <li class="skeleton" aria-hidden="true"></li>
            <li class="skeleton" aria-hidden="true"></li>
            <li class="skeleton" aria-hidden="true"></li>
          </ul>
        </div>
      </div>
      <!-- 左栏的收藏夹视图：右栏那一整套的第二个实例（模板同一份，id 前缀不同）。 -->
      <div class="left-view" id="left-archive-view" hidden>
${archiveColumnMarkup('left-archive')}
      </div>
    </section>

    <div class="mid">
      <button type="button" class="btn btn--primary btn--move" id="save-btn" disabled>
        <span class="move__arrow">→</span>
        <span id="save-label">存过去</span>
      </button>
      <button type="button" class="btn btn--move" id="open-btn" disabled
              title="在当前窗口打开勾选的内容">
        <span class="move__arrow">←</span>
        <span id="open-label">打开</span>
      </button>
      <button type="button" class="btn btn--move" id="open-window-btn" disabled
              title="在新窗口打开勾选的内容">
        ${plusIcon('move__icon')}
        <span id="open-window-label">新窗口</span>
      </button>
      <!--
        「打开不建分组」作用于上面两个打开按钮（不建标签分组）。
        它是一个**修饰**而不是一个入口：分成两个按钮就会出现「哪两个是同一件事」的疑问，
        而它本来就可以用在当前窗口与新窗口两种情况上。
        文案带上「打开」是因为它与上面那个「存过去」无关——只写「不建分组」会被读成也管保存。
      -->
      <label class="check" id="no-group-host">
        <input type="checkbox" id="no-group-check" />
        <span>打开不建分组</span>
      </label>
      <!--
        撤销按钮**始终占位**（没有可撤销的东西时用 visibility 藏起来，而不是 display: none）：
        一出现就把上面三个按钮顶上去，看着像界面跳了一下。
      -->
      <button type="button" class="btn btn--ghost btn--sm" id="undo-btn" disabled>撤销上次保存</button>

      <!--
        两栏都是收藏夹时，中间这一列换成「搬」而不是「开」：
        书签到书签用的是 bookmarks.move（**移动**，不是复制），而上面那一整组
        （存过去 / 打开 / 新窗口 / 不建分组 / 撤销）都是窗口语义，在这个档下没有意义。

        箭头方向就是两栏的方向：箭头指哪边，就是把勾选的东西送到哪边。
      -->
      <div class="mid__archive" id="mid-archive" hidden>
        <button type="button" class="btn btn--primary btn--move" id="move-right-btn" disabled>
          <span class="move__arrow">→</span>
          <span id="move-right-label">移动过去</span>
        </button>
        <button type="button" class="btn btn--move" id="move-left-btn" disabled>
          <span class="move__arrow">←</span>
          <span id="move-left-label">移动过来</span>
        </button>
      </div>
    </div>

    <section class="col" id="right-col">
      <header class="col__head">
        <h2 class="col__title">收藏夹 <span class="badge" id="archive-count">0</span></h2>
        <!--
          收藏文件夹的 chip 栏由 App 挂进这个位置（见导出常量 FAVORITE_HOST_ID）：
          面板只提供位置，不知道该挂什么——它要是自己 import 那个模块，两个界面模块就栓到一起了。

          它跟在标题**右边**（不是另起一行）：标题只是两个字加一枚胸章，而右边那一大片
          本来就空着。放同一行之后省下一行的高度，chip 多的时候也还有地方换行
          （flex-wrap，见 app.css 的 .col__head）。
        -->
        <div class="favs-host" id="${FAVORITE_HOST_ID}"></div>
      </header>
${archiveColumnMarkup('archive')}
    </section>
  </div>

  <!--
    状态行**始终占一行高**（见 .status-bar）：不然一次操作后它忽然多出一行文字，
    就会把上面那两栏的高度抽走一点，中间那几个按钮跟着跳一下。
  -->
  <div class="row status-bar">
    <span class="status" id="status" hidden></span>
  </div>
`

/**
 * 保存 / 打开两栏视图。
 *
 * 两栏装的是**同一个东西的两侧**：左边是活会话（当前窗口，标签还住在浏览器里），
 * 右边是已落盘的（收藏夹里的文件夹与散装书签）。两者同形——都是有序的「分组 | 标签」序列——所以：
 *
 * - 「存过去」与「打开」会把左栏或右栏**当前勾选**的内容整体送过去；
 * - 拖拽是同一件事的**精确版**：拖一条标签就只存这一条，落在哪个文件夹行上就进哪个文件夹；
 * - 没有会话层：每次保存都是往当前展示的那一层里**追加**，不做去重，同名文件夹也不合并。
 */
export interface TransferPanel extends Panel {
  /** 跳到某一层。右栏的 chip 栏用它——导航归面板，外部只发意图。 */
  navigateTo(folderId: string): Promise<void>
  /** 跳到左栏那一层（左栏的 chip 栏用它）。必要时会先把左栏切到收藏夹档。 */
  navigateToLeft(folderId: string): Promise<void>
  /** 右栏正站在哪一层（空串表示还没落到任何一层）。 */
  currentFolderId(): string
  /** 左栏正站在哪一层（只有收藏夹档下才有值）。 */
  leftFolderId(): string
}
export function createTransferPanel(events: AppEvents): TransferPanel {
  const element = createPanelElement('transfer')
  element.innerHTML = TEMPLATE

  const status = q<HTMLSpanElement>(element, '#status')
  const windowView = q<HTMLElement>(element, '#window-view')
  const leftArchiveView = q<HTMLElement>(element, '#left-archive-view')
  const leftCol = q<HTMLElement>(element, '#left-col')
  const rightCol = q<HTMLElement>(element, '#right-col')
  const leftFavoritesHost = q<HTMLElement>(element, `#${LEFT_FAVORITE_HOST_ID}`)
  const midArchive = q<HTMLElement>(element, '#mid-archive')
  const moveRightButton = q<HTMLButtonElement>(element, '#move-right-btn')
  const moveRightLabel = q<HTMLSpanElement>(element, '#move-right-label')
  const moveLeftButton = q<HTMLButtonElement>(element, '#move-left-btn')
  const moveLeftLabel = q<HTMLSpanElement>(element, '#move-left-label')

  /**
   * 共享的忙标记。
   *
   * 两栏各有一个收藏夹实例（左栏现在也能切成收藏夹），但「正在写入」是全局的一件事：
   * 保存到一半不该能删书签。所以**不各记一份**，而是两栏读写同一个对象。
   */
  const flags = {busy: false}

  /**
   * 两栏的收藏夹实例。
   *
   * 右栏一直有；左栏那个在「当前窗口」档下藏着（`display: none`），切过去才读数据。
   * 元素靠 **id 前缀**分开（`archive` / `left-archive`）——两个实例住在同一份 DOM 里，
   * id 重了就会各自找到对方的东西。
   *
   * `rememberWrite` / `favoriteIds` 读的是下面才声明的变量：回调都在用户操作之后才执行，
   * 那时它们早已初始化（与 `App.ts` 里现问 `panel.currentFolderId()` 同一个道理）。
   */
  const paneDeps = {
    events,
    flags,
    status,
    rememberWrite: (result: {folderIds: string[]; bookmarkIds: string[]}) => {
      lastWrite = {folderIds: result.folderIds, bookmarkIds: result.bookmarkIds}
    },
    favoriteIds: () => favoriteFolderIds,
    // 换层或勾选变了时重算中间那一列（存过去的提示、「打开 / 移动 (N)」）。
    onStateChanged: () => updateButtons()
  }
  const archive: ArchivePane = createArchivePane({...paneDeps, root: rightCol, idPrefix: 'archive'})
  const leftArchive: ArchivePane = createArchivePane({
    ...paneDeps,
    // 根用**整栏**而不是那个视图：胸章（`left-archive-count`）在表头里，不在视图里。
    // id 都带前缀，所以在整栏范围内查也不会串到右栏去。
    root: leftCol,
    idPrefix: 'left-archive'
  })

  const windowList = q<HTMLUListElement>(element, '#window-list')
  const windowCount = q<HTMLSpanElement>(element, '#window-count')
  const saveButton = q<HTMLButtonElement>(element, '#save-btn')
  const saveLabel = q<HTMLSpanElement>(element, '#save-label')
  const openButton = q<HTMLButtonElement>(element, '#open-btn')
  const openLabel = q<HTMLSpanElement>(element, '#open-label')
  const openWindowButton = q<HTMLButtonElement>(element, '#open-window-btn')
  const openWindowLabel = q<HTMLSpanElement>(element, '#open-window-label')
  const undoButton = q<HTMLButtonElement>(element, '#undo-btn')
  const noGroupHost = q<HTMLElement>(element, '#no-group-host')
  const noGroupCheck = q<HTMLInputElement>(element, '#no-group-check')

  const windowSelectAll = createSelectAll(q<HTMLDivElement>(element, '#window-all-host'), {
    describe: (kept, total) =>
      total === 0
        ? '当前窗口没有可保存的标签页'
        : kept === total
          ? `已全选 ${total} 个标签页`
          : `已选 ${kept} / ${total} 个标签页`,
    onChange: (wantAll) => {
      if (wantAll) for (const tab of allWindowTabs()) windowSelected.add(tab.tabId)
      else windowSelected.clear()
      syncWindowStates()
    }
  })

  /**
   * 两面板的刷新按钮。
   *
   * 它们都挂在**全选框那一行的右端**（左栏挂在 `#window-all-host`、右栏挂在 `#archive-all-host`），
   * 两栏位置对称。不紧跟在全选框文字后面是有原因的：那行文字会随勾选从
   * 「已全选 3 个标签页」变成「已选 2 / 127 个标签页」，紧跟就会左右滑动。
   *
   * **必须在两个全选框都建好之后再 append**：`createSelectAll()` 也是往同一行里 append 的，
   * 而按钮靠 `margin-left: auto` 贴右——一旦按钮先插进去，它会把后面的标签挤到行尾，
   * 看着就像「刷新按钮跑到左边去了」（实测右栏就是这样：按钮 784、标签 1239–1384）。
   *
   * 两者都**不置灰**（哪怕 `busy`）：这是手动退路，正因为「界面看着不对」才点它。
   * 两者走的是**同一条** `refresh()`：右栏不为「只重读书签树」另写一条路径，
   * 多一条路径就多一处会分叉的地方。
   */
  function makeRefreshButton(id: string, label: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.id = id
    button.className = 'btn btn--ghost btn--icon'
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = REFRESH_ICON
    button.addEventListener('click', async () => {
      await refresh()
      setStatus(status, '已刷新。', 'ok')
    })
    return button
  }


  // 两个全选框都建好之后才插刷新按钮：它们靠贴右把自己推到行尾，
  // 先插进去会把后面的全选框挤走（见 `makeRefreshButton` 的注释）。
  //
  // 右栏那两个按钮包在**同一个组**里：两个 `margin-left: auto` 会把剩余空间**平分**，
  // 两个按钮就各自被推到左边一截、中间留一大块空白（实测相距 216px）。
  // 包成一组之后只有最外层那个 `auto` 生效，两个按钮就紧挨着靠在行尾。
  // 顺序也是刻意的：管理器在左、刷新在右（刷新是「重新看一眼」，放最外面最顺手）。
  //
  // 右栏那两枚都不是面板的：管理器按钮归收藏夹实例，所以这里只往它留出的位置里放东西。
  // 而这一行**必须在 `createArchivePane` 之后**——全选框是它建好并 append 进去的。
  q<HTMLDivElement>(element, '#window-all-host').append(
    makeRefreshButton('window-refresh-btn', '重新读取当前窗口的标签页')
  )
  // 右栏那一组（管理器 + 刷新）。左栏的收藏夹档也照摆一组，两栏位置对称——
  // 左栏那个实例用的是它自己的管理器按钮，刷新按钮也各有一个（它俩读的是各栏那一层）。
  for (const [pane, prefix, label] of [
    [archive, 'archive', '重新读取书签树'],
    [leftArchive, 'left', '重新读取左栏这一层']
  ] as const) {
    const actions = document.createElement('div')
    actions.className = 'row row--compact row--push-end'
    actions.append(pane.openRootButton, makeRefreshButton(`${prefix}-refresh-btn`, label))
    pane.actionsHost.append(actions)
  }

  /**
   * 收藏的文件夹（书签树 id，按用户排的顺序）。
   *
   * 它们只是**快捷方式**，不是边界：右栏可以在书签树里任意导航（包括走到收藏**上面**的层），
   * 写入跟的一直是当前展示的那一层。顺序有意义——第一个可用的是打开界面时的落点。
   */
  let favoriteFolderIds: string[] = []
  let windowChildren: WindowChild[] = []



  /**
   * 左栏上一次渲染用的签名。
   *
   * 初次为 `undefined`（还没渲染过，列表里是骨架），所以第一次一定会建 DOM。
   */
  let windowSignature: string | undefined
  /**
   * 左栏**被勾选**的标签 id。
   *
   * 保存侧现在是**默认一个都不选**（用户要的是「挑几条去存」，而不是「先整窗收起来再排除几条」），
   * 所以这里记的是选中集，不是排除集。右边收藏夹那一侧也默认不选，但用的是排除集 +
   * 一份「见过的书签」（因为那边的列表会随导航换掉，见 `applyArchive`）。
   */
  const windowSelected = new Set<number>()
  /**
   * 左栏里正在等第二次确认的关闭目标。
   *
   * 与右栏的 `pendingDeleteId` 分开一个变量：两边长得像，但一个是书签 id、一个是
   * tabId / 分组下标，合成一个变量只会让两处的判断互相干扰。
   */
  let pendingClose: {kind: 'tab'; tabId: number} | {kind: 'group'; index: number} | undefined
  /** 撤销目标：最近一次写入新建的 id。只存在内存里（见 docs/design.md）。 */
  let lastWrite: {folderIds: string[]; bookmarkIds: string[]} | undefined
  /** 正在拖的是什么；`dragover` 靠它决定收不收。 */
  let dragging: DragPayload | undefined
  /**
   * 这一次拖动**从哪一栏**开始（只有内部拖动有值）。
   *
   * 两栏都有收藏夹条目，而载荷里只有 id —— 光看 id 分不出它来自哪一边
   * （两栏停在同一层时，两边认得的是同一批 id，那就真的有歧义了）。
   * 所以起点在 `dragstart` 时记一次。
   */
  let draggingPane: ArchivePane | undefined

  /**
   * 左栏看什么。
   *
   * **不落盘**：与展开状态同理，它是一次浏览过程中的视图状态，不是偏好——
   * 打开界面永远是「窗口 ⇄ 收藏夹」那副样子。
   */
  let mode: Mode = 'window'

  /**
   * 切换左栏这一档。
   *
   * 两侧的收藏夹数据都**只在自己可见时才读**：窗口档下左栏那个实例是 `display: none`，
   * 读了也白读（还要多一次 `getSubTree`）。所以第一次切过去时才 `reload()`。
   */
  async function setMode(next: Mode): Promise<void> {
    if (mode === next) return
    mode = next
    applyMode()
    if (next === 'archive') await leftArchive.reload()
    updateButtons()
  }

  /**
   * 让界面反映 `mode`：换左栏那一块、换中间那一列、给出两档的选中态。
   *
   * 中间那一列**整组换掉**而不是留一半：窗口语义的五个控件（存过去 / 打开 / 新窗口 /
   * 不建分组 / 撤销）在书签 ⇄ 书签时一个都不成立，留着它们只会让人以为那也能用。
   */
  function applyMode(): void {
    const isArchive = mode === 'archive'
    windowView.hidden = isArchive
    leftArchiveView.hidden = !isArchive
    // 左栏的 chip 栏只在看着收藏夹时露面（看窗口时它没地方可跳）。
    leftFavoritesHost.hidden = !isArchive
    for (const button of element.querySelectorAll<HTMLButtonElement>('.mode')) {
      const active = button.dataset.mode === mode
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    }
    saveButton.hidden = isArchive
    openButton.hidden = isArchive
    openWindowButton.hidden = isArchive
    noGroupHost.hidden = isArchive
    undoButton.hidden = isArchive
    midArchive.hidden = !isArchive
  }

  // ———————————————— 左栏 ————————————————

  function allWindowTabs(): TabSnapshot[] {
    return windowChildren.flatMap((child) =>
      child.kind === 'tab' ? [child.tab] : [...child.tabs]
    )
  }

  function windowKeptTabs(tabs: readonly TabSnapshot[]): TabSnapshot[] {
    return tabs.filter((tab) => windowSelected.has(tab.tabId))
  }

  /** 左栏里「还会被存下去」的子级：整组没选就不写这个文件夹。 */
  function keptWindowChildren(): WindowChild[] {
    return windowChildren.flatMap<WindowChild>((child) => {
      if (child.kind === 'tab') return windowSelected.has(child.tab.tabId) ? [child] : []
      const tabs = windowKeptTabs(child.tabs)
      return tabs.length > 0 ? [{...child, tabs}] : []
    })
  }

  /**
   * 行尾那一对「关闭 / 确认关闭 + 取消」（左栏用）。
   *
   * 与右栏的「删除」同一套两步确认：关闭是**不可逆**的（标签里的内容没存下来就没了），
   * 而它在行尾离「打开」只有一个按钮的距离，误点太容易。
   *
   * 两档的宽度并不相同（「确认关闭」四个字 + 一个「取消」比「关闭」宽 70 多像素）——**不刻意定宽**：
   * 与右栏的「删除 → 确认删除」同一套做法，代价只是**这一行**里「打开」往左让一格、
   * 标题短一点；行高不变、别的行一个都不动。反过来若给它预留那么宽，
   * 每一行平时都要白占 70 像素的标题空间，那更亏。
   */
  function closeSlotMarkup(kind: 'tab' | 'group', id: number, label: string): string {
    const key = closeKey(kind, id)
    if (pendingCloseKey() !== key) {
      return `<button type="button" class="btn btn--ghost btn--sm" data-close="${key}"
                  title="${label}">关闭</button>`
    }
    return `<button type="button" class="btn btn--danger btn--sm" data-confirm-close="${key}"
                title="${label}">确认关闭</button>
            <button type="button" class="btn btn--ghost btn--sm" data-cancel-close="">取消</button>`
  }

  /** 左栏关闭目标的主键：`t<tabId>` / `g<分组下标>`。用一个字符串就够了（不分两种状态）。 */
  function closeKey(kind: 'tab' | 'group', id: number): string {
    return `${kind === 'tab' ? 't' : 'g'}${id}`
  }

  /** 当前正在等确认的那个关闭目标的主键。渲染时用它决定画「关闭」还是「确认关闭」。 */
  function pendingCloseKey(): string | undefined {
    if (!pendingClose) return undefined
    return closeKey(
      pendingClose.kind,
      pendingClose.kind === 'tab' ? pendingClose.tabId : pendingClose.index
    )
  }

  /** `data-close` 值 → 关闭目标。 */
  function parseCloseKey(value: string): {kind: 'tab'; tabId: number} | {kind: 'group'; index: number} {
    const id = Number(value.slice(1))
    return value.startsWith('t') ? {kind: 'tab', tabId: id} : {kind: 'group', index: id}
  }

  /**
   * 一条标签行。
   *
   * 三个 data 属性各有用处：`data-row` 供「点整行切换勾选」找到勾选框；
   * `data-tab-index` 与 `data-tab-group` 供拖拽算落点（插到哪儿、归哪个组）。
   *
   * 副文案是**完整网址**（与右栏收藏夹条目一致）：同一站点下的不同页面靠路径区分，
   * 只显示主机名时两条看起来一模一样。太长的仍会省略，完整那份在 `title` 里。
   *
   * 行尾三个按钮从左到右是：**加载 / 释放·打开·关闭**。左边那个是「这一页的状态」
   * （见 `statusSlotMarkup()`），中间是「跳过去」，右边是「关掉它」。
   */
  function tabRowMarkup(tab: TabSnapshot): string {
    const url = tab.url
    const groupAttr = tab.groupId === undefined ? '' : ` data-tab-group="${tab.groupId}"`
    return `
      <li class="item leaf" draggable="true" data-row data-drop-row="tab"
          data-tab-index="${tab.index}"${groupAttr} data-drag-tab="${tab.tabId}">
        <input type="checkbox" data-window-tab="${tab.tabId}" />
        ${faviconMarkup(url, FAVICON_BASE)}
        <span class="item__main">
          <span class="item__title">${escapeHtml(tab.title || url)}${tab.pinned ? PIN_ICON : ''}</span>
          <span class="item__meta item__meta--url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        </span>
        <span class="tree__actions">${statusSlotMarkup(tab)}
          <button type="button" class="btn btn--ghost btn--sm"
                  data-switch-tab="${tab.tabId}" title="切换到这个标签页">打开</button>
          ${closeSlotMarkup('tab', tab.tabId, '关闭这一枚标签页（里面的内容不会存下来）')}
        </span>
      </li>
    `
  }

  /**
   * 行尾那个位置的三种样子（加载 / 加载中 / 释放）。
   *
   * - `unloaded`：标签被 Chrome 卸载了（懒加载出来的，或它自己卸的）→ 可点的「加载」。
   * - `loading`：点过「加载」之后、到页面给出标题之前的那一段 → 「加载中」并禁用。
   *   这一段可能持续很久，而**页面什么时候给出标题由网站自己决定**：
   *   有的站点（x.com 这类重 SPA）在标签不可见时走不到设置标题那一步，
   *   于是标题要等用户切过去才更新。显示「加载中」比让按钮无声消失诚实得多——
   *   否则用户看到的是「点了没反应」。
   * - `complete` 且**不是活动标签**：给一个「释放」，把这一页占的内存交回去（点开时才重新加载）。
   *   活动标签不给：它就在屏幕上，卸载它没意义（浏览器马上就会读回来）。
   *   Chromium 自己的 discards 页用的是同一条判据（`visibility !== VISIBLE`）。
   *
   * 三个分支都占同一个位置（`.btn--load` 定宽）：
   * 「加载」两个字、「加载中」三个字，不定宽就会在切换时差一个字宽。
   */
  function statusSlotMarkup(tab: TabSnapshot): string {
    if (tab.status === 'unloaded') {
      return `<button type="button" class="btn btn--ghost btn--sm btn--load" data-load-tab="${tab.tabId}"
                  title="在后台加载这一页（标签已卸载）">加载</button>`
    }
    if (tab.status === 'loading') {
      return `<button type="button" class="btn btn--ghost btn--sm btn--load" disabled
                  title="这一页正在加载">加载中</button>`
    }
    if (tab.active) return ''
    return `<button type="button" class="btn btn--ghost btn--sm btn--load" data-release-tab="${tab.tabId}"
                title="释放这一页占用的内存（点开时才重新加载，地址不会丢）">释放</button>`
  }

  /**
   * 一行里影响「画出来什么」的字段，顺序即渲染顺序。
   *
   * 不只是文字：`active` 不显示在行里，但它决定行尾给不给「释放」，
   * 所以它也算「画出来的一部分」——漏进签名就会出现「该重画的没重画」。
   */
  function drawnFieldsOf(tab: TabSnapshot): (string | number)[] {
    return [tab.tabId, tab.title, tab.url, tab.pinned ? 1 : 0, tab.status, tab.active ? 1 : 0]
  }

  /**
   * 左栏现在的样子：结构 + 文本。
   *
   * **勾选不在签名里**：它由 `syncWindowStates()` 回填，把它算进签名反而会因为「勾一下」
   * 重建整列（而重建又会把勾选框恢复成未勾选）。
   *
   * 反过来，**凡是行里画出来的东西都要进签名**：漏了 `status`，点了「加载」之后那一行不会变；
   * 漏了分组内的 `pinned`，组内标签固定后那个图钉要等到别的变化才出现（两处都是实测踩到的）。
   *
   * 拼串交给 `JSON.stringify`，**不自己定分隔符**。手写的分隔符都要求「内容里不会出现这个字符」，
   * 而标题与网址里什么字符都可能出现（实测：用空格拼时 `[a, b, a b]` 与 `[a b, a, b]` 拼出了同一个串，
   * 该重画的就被「结构没变」跳过去了）。JSON 的转义是双射、数组结构自己就编码了「几条记录、谁是分组」，
   * 于是连记录之间的分隔符都不需要。
   *
   * 天真的反例：以前用裸 NUL 当分隔符，既留下了那个「内容里不能有 NUL」的前提，
   * 又让 ripgrep 把整个文件当二进制（**这个文件会从搜索结果里整个消失**），
   * 还让编辑工具改不动这一段（`oldString` 表达不了裸控制字符）。这两件事都是实测踩到的。
   *
   * 代价是**字段要显式列出**——而这恰好是我们想要的：把整份快照直接塞进去会把 `lastAccessed`
   * 也算上，而它每点一次标签就变，签名会永远在变，「结构没变就跳过重建」就彻底失效了。
   */
  function windowSignatureOf(children: readonly WindowChild[]): string {
    return JSON.stringify(
      children.map((child) =>
        child.kind === 'tab'
          ? ['t', ...drawnFieldsOf(child.tab)]
          : ['g', child.name, child.tabs.map(drawnFieldsOf)]
      )
    )
  }

  function renderWindow(): void {
    // 结构没变就什么都不做。
    //
    // `refresh()` 会被频繁重跑（保存、删除、改名、拖一条收藏夹条目…），而它每次都要重建整个左栏：
    // 用户的屏幕上就是一次无意义的整列重绘（实测：挪一根分隔线时「存过去 (N)」闪一下）。
    // 凡是「由外部数据驱动、又会被频繁重跑」的渲染，都要先问一句：内容没变时能不能什么都不做。
    const signature = windowSignatureOf(windowChildren) + '|' + (pendingCloseKey() ?? '')
    if (signature === windowSignature) {
      syncWindowStates()
      return
    }
    windowSignature = signature
    windowCount.textContent = String(allWindowTabs().length)

    if (windowChildren.length === 0) {
      windowList.innerHTML = '<li class="empty">当前窗口没有可保存的标签页。</li>'
      // 早退时也要走同步：它里面会刷新全选框的文案与三态。
      // 只调 `updateButtons()` 的话，全选框会停在上一次的数字上（实测换到没有标签的窗口时，
      // 文案还写着上一个窗口的枚数）。
      syncWindowStates()
      return
    }

    windowList.innerHTML = windowChildren
      .map((child, index) => {
        if (child.kind === 'tab') return tabRowMarkup(child.tab)
        // 分组行的 groupId 从组内第一枚标签上取：整组同属一个分组，取一个就够。
        const bucketGroupId = child.tabs[0]?.groupId
        const groupAttr = bucketGroupId === undefined ? '' : ` data-group-id="${bucketGroupId}"`
        return `
          <li class="group" data-row data-drop-row="group"${groupAttr}>
            <div class="item group__head" draggable="true" data-drag-group="${index}">
              <input type="checkbox" data-window-group="${index}" />
              <span class="item__title">${escapeHtml(child.name)}</span>
              <span class="item__meta">${child.tabs.length} 个标签</span>
              <span class="tree__actions">${closeSlotMarkup(
                'group',
                index,
                `解散这一组并关闭它的全部标签页（共 ${child.tabs.length} 枚已列出；组里的浏览器内部页面也会一起关）`
              )}</span>
            </div>
            <ul class="kids">${child.tabs.map(tabRowMarkup).join('')}</ul>
          </li>
        `
      })
      .join('')

    syncWindowStates()
  }

  /** 让左栏的勾选框反映 `windowSelected`。`innerHTML` 写不出 `checked`，必须手工回填。 */
  function syncWindowStates(): void {
    for (const input of windowList.querySelectorAll<HTMLInputElement>('[data-window-tab]')) {
      input.checked = windowSelected.has(Number(input.dataset.windowTab))
    }

    for (const input of windowList.querySelectorAll<HTMLInputElement>('[data-window-group]')) {
      const child = windowChildren[Number(input.dataset.windowGroup)]
      if (!child || child.kind !== 'group') continue
      const kept = windowKeptTabs(child.tabs).length
      input.checked = kept > 0
      input.indeterminate = kept > 0 && kept < child.tabs.length
    }

    const tabs = allWindowTabs()
    windowSelectAll.update(
      tabs.filter((tab) => windowSelected.has(tab.tabId)).length,
      tabs.length
    )
    updateButtons()
  }

  // ———————————————— 状态 ————————————————

  /**
   * 面板级的刷新：设置 + 左栏 + 右栏。
   *
   * 两栏那两个刷新按钮都走这一条路——**不给某一栏另写一条「只重读书签树」的路径**，
   * 多一条路径就多一处会分叉的地方。
   *
   * 左栏那个收藏夹实例只在它可见时才重读：窗口档下它是隐形的，重读一遍谁也看不见，
   * 只是白白多一次 `getSubTree`。
   */
  async function refresh(): Promise<void> {
    favoriteFolderIds = (await loadSettings()).favoriteFolderIds
    windowChildren = planWindowChildren(await snapshotCurrentWindow())

    // 标签被关掉之后它的 tabId 不会再出现；留着只会让集合越涨越大。
    const aliveTabs = new Set(allWindowTabs().map((tab) => tab.tabId))
    for (const tabId of [...windowSelected]) if (!aliveTabs.has(tabId)) windowSelected.delete(tabId)

    renderWindow()
    if (mode === 'archive') await leftArchive.reload()
    await archive.reload()
  }

  /**
   * 中间那一列的可用状态与计数。
   *
   * 两档各算各的：窗口档是「存过去 / 打开 / 新窗口 / 撤销」（跟着左栏的标签勾选），
   * 收藏夹档是「移动过去 / 移动过来」（跟着**两栏各自的**书签勾选）。
   * 两套都算一遍而不是只算当前那档——另一档的按钮还留在 DOM 里，切回去时不该先闪一个旧数字。
   *
   * 收藏夹实例自己那几枚（新建文件夹 / 记号 / 全部展开 / 管理器）不在这里，
   * 由 `ArchivePane.updateButtons()` 管：合成一个函数会让「谁的按钮在谁手里」变成猜谜。
   */
  function updateButtons(): void {
    const keptTabs = allWindowTabs().filter((tab) => windowSelected.has(tab.tabId)).length
    const keptBookmarks = archive.keptCount()

    saveLabel.textContent = countLabel('存过去', keptTabs)
    openLabel.textContent = countLabel('打开', keptBookmarks)
    openWindowLabel.textContent = countLabel('新窗口', keptBookmarks)
    // 落点写在按钮自己的提示里：写入目标是「当前展示的这一层」，而那一层远在右栏里侧的路径行里，
    // 中间的按钮与它隔了一整栏。悬停能确认「到底存进哪个文件夹」，不必来回对路径。
    saveButton.title = archive.isWritable()
      ? `存进「${archive.currentFolderTitle()}」`
      : '书签树的根不接受写入，请先进入某个文件夹'
    saveButton.disabled = flags.busy || keptTabs === 0 || !archive.isWritable()
    openButton.disabled = flags.busy || keptBookmarks === 0
    openWindowButton.disabled = flags.busy || keptBookmarks === 0
    // 撤销按钮**始终占位**：没有可撤销的东西时只是藏起来（`visibility` 不进布局也不接键盘焦点），
    // 这样它出现 / 消失都不会把上面三个按钮上下推一下。
    undoButton.classList.toggle('is-slot-hidden', !lastWrite)
    undoButton.disabled = flags.busy || !lastWrite

    // 「移动过去」搬的是**左栏**勾选的那些东西，落到右栏当前这一层；
    // 「移动过来」反过来。所以一个按钮的计数来自一边、落点来自另一边——别弄反。
    //
    // 计数是**要搬走的条目数**：一个整选的文件夹算一条（搬的是它本身），
    // 与旁边「打开 (N)」按书签数是两个口径——打开出来的是一枚枚标签，
    // 搬走的是一个文件夹，这两件事的单位本来就不是一回事。具体搬什么写在悬停提示里。
    const leftItems = leftArchive.keptItems()
    const rightItems = archive.keptItems()
    moveRightLabel.textContent = countLabel('移动过去', leftItems.length)
    moveLeftLabel.textContent = countLabel('移动过来', rightItems.length)
    moveRightButton.title =
      leftItems.length === 0
        ? '左栏还没有勾选任何东西'
        : `把左栏勾选的 ${describeItems(leftItems)}移到「${archive.currentFolderTitle()}」`
    moveLeftButton.title =
      rightItems.length === 0
        ? '右栏还没有勾选任何东西'
        : `把右栏勾选的 ${describeItems(rightItems)}移到「${leftArchive.currentFolderTitle()}」`
    moveRightButton.disabled = flags.busy || leftItems.length === 0 || !archive.isWritable()
    moveLeftButton.disabled = flags.busy || rightItems.length === 0 || !leftArchive.isWritable()

    archive.updateButtons()
    leftArchive.updateButtons()
  }

  /**
   * 跳到左栏那一层（左栏的 chip 栏点一下就走到这里）。
   *
   * 它会**顺手把左栏切到收藏夹档**：点左栏的 chip 只可能发生在那一档下，但把这两件事写在一起，
   * 就不需要「谁保证调用顺序」这种默契。
   */
  async function navigateToLeft(folderId: string): Promise<void> {
    if (mode !== 'archive') await setMode('archive')
    await leftArchive.navigateTo(folderId)
  }

  /** 只重读左栏。窗口里的标签变了（而收藏夹没动）时用它。 */
  async function refreshWindowOnly(): Promise<void> {
    windowChildren = planWindowChildren(await snapshotCurrentWindow())
    // 被关掉的标签不能继续留在选中集里，否则那个集合只会越涨越大。
    const alive = new Set(allWindowTabs().map((tab) => tab.tabId))
    for (const tabId of [...windowSelected]) if (!alive.has(tabId)) windowSelected.delete(tabId)
    renderWindow()
  }

  /**
   * 窗口里**任何**标签变化都重读左栏。
   *
   * 之前只有我们自己的动作才会主动 `refresh()`，所以不由我们发起的变化就看不到：最典型的是
   * 「从收藏夹拖一条到左栏」——新建的标签刚出现时 `url` 可能还没提交（此时它会被
   * `isInternalUrl('')` 当成内部页面过滤掉），而下一次刷新要等到用户再点别的东西。
   * 现在由事件驱动：谁改的窗口都算数，界面自己会跟上（拿到提交后的 `url` 那一轮就会把标签补上）。
   *
   * 去抖是必需的：一次拖动会连着触发好几个事件（`onCreated` + `onUpdated` + `onMoved`…），
   * 不去抖就会在一惊之内重读好几遍。
   */
  const WINDOW_REFRESH_DEBOUNCE_MS = 120
  let windowRefreshTimer: number | undefined
  function scheduleWindowRefresh(): void {
    if (windowRefreshTimer !== undefined) return
    windowRefreshTimer = window.setTimeout(() => {
      windowRefreshTimer = undefined
      void refreshWindowOnly()
    }, WINDOW_REFRESH_DEBOUNCE_MS)
  }

  chrome.tabs.onCreated.addListener(scheduleWindowRefresh)
  chrome.tabs.onRemoved.addListener(scheduleWindowRefresh)
  chrome.tabs.onMoved.addListener(scheduleWindowRefresh)
  chrome.tabs.onAttached.addListener(scheduleWindowRefresh)
  chrome.tabs.onDetached.addListener(scheduleWindowRefresh)
  chrome.tabGroups.onUpdated.addListener(scheduleWindowRefresh)

  /**
   * 活动标签变了也要重读：行尾给不给「释放」取决于 `Tab.active`。
   *
   * 别的窗口激活标签也会派发这个事件，而它只有一次去抖过的 `tabs.query`，
   * 不值得为此记住「我们的窗口 id 是几」（那还会多一份会过期的状态）。
   */
  chrome.tabs.onActivated.addListener(scheduleWindowRefresh)

  /**
   * 标签在 Chrome 内部被换掉了 WebContents —— 目前只有一条路会走到这里：**释放**。
   *
   * 为什么必须处理：扩展看到的 `Tab.id` 是 `SessionTabHelper::IdForTab(webContents)`，
   * 而释放的旧实现会把 WebContents 换成一个空的（新的那个有自己的 id），
   * 也就是**释放之后这一枚的 tab id 会变**（Chrome 自己的 API 测试里就写着
   * 「the id changes after a tab is discarded」）。而界面里「勾选了哪几枚」正是按 tabId 存的，
   * 不管的话勾选会在释放的那一刻**静默丢掉**（`refreshWindowOnly()` 会把不认识的 id 剪掉）。
   *
   * `onReplaced(addedTabId, removedTabId)` 给的正好是这张新旧对照表，所以把勾选搬过去。
   * 迁移必须在刷新之前做完：刷新会剪掉「不在窗口里」的 id，而此刻旧 id 已经不在窗口里了。
   */
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    if (windowSelected.delete(removedTabId)) windowSelected.add(addedTabId)
    // 正在等确认的那一枚也要搬：不搬的话确认按钮会指向一个已经不在的 id，
    // 点了之后 Chrome 抛「No tab with id」，而那本来是个正常操作。
    if (pendingClose?.kind === 'tab' && pendingClose.tabId === removedTabId) {
      pendingClose = {kind: 'tab', tabId: addedTabId}
    }
    scheduleWindowRefresh()
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // 只关心会改变这一行长相的字段。
    //
    // `status` 是必需的，不是顺手加的：卸载 / 正在加载 / 加载完三种状态各对应行尾的一种样子
    // （「加载」/「加载中」/「释放」），而且它与 `discarded` **永远在同一个事件里
    // 一起到达**（Chrome 那边同时插入两个 key）。少了它，点「加载」之后那行不会变，
    // 看起来就是「点了没反应」。
    if (
      changeInfo.title !== undefined ||
      changeInfo.url !== undefined ||
      changeInfo.groupId !== undefined ||
      changeInfo.pinned !== undefined ||
      changeInfo.status !== undefined
    ) {
      scheduleWindowRefresh()
    }
  })



  // ———————————————— 写入 / 撤销 / 打开 ————————————————

  async function writeInto(parentId: string, children: readonly WindowChild[]): Promise<void> {
    if (children.length === 0) return
    flags.busy = true
    updateButtons()
    try {
      const result = await writeChildren(parentId, children)
      lastWrite = {folderIds: result.folderIds, bookmarkIds: result.bookmarkIds}
      // 新存下的分组展开给自己看（存下去的是一整组，收起来那个文件夹看不出存了什么），
      // 并把它滚进视野——写入总是追加到这一层的末尾，那一行往往在屏幕外。
      if (result.folderIds.length > 0) {
        archive.expandOnNextReload(result.folderIds, result.folderIds[0])
      }
      const parts = [`已存下 ${result.saved} 个标签页`]
      if (result.groups > 0) parts.push(`${result.groups} 个分组`)
      setStatus(status, parts.join(' · '), 'ok')
      await events.archiveChanged()
      await refresh()
    } catch (error) {
      setStatus(status, `保存失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      updateButtons()
    }
  }

  /**
   * 撤销最近一次写入：先删新建的书签，再删新建的分组文件夹。
   *
   * 顺序不能反：删文件夹会连带删掉里面的书签，先删文件夹会让后面的书签 id 全部失效。
   */
  async function undo(): Promise<void> {
    if (flags.busy || !lastWrite) return
    const target = lastWrite
    lastWrite = undefined
    flags.busy = true
    updateButtons()

    try {
      for (const id of [...target.bookmarkIds, ...target.folderIds]) {
        // 用户可能已经手动删掉了那一项，所以失败要吞掉——否则一次撤销会把后面的全卡住。
        try {
          await removeSubTree(id)
        } catch {
          /* 已经不存在了 */
        }
      }
      setStatus(status, `已撤销：删掉刚存下的 ${target.bookmarkIds.length} 个标签页。`, 'ok')
    } finally {
      flags.busy = false
      await events.archiveChanged()
    }
  }

  /**
   * 打开右栏当前勾选的内容。
   *
   * 直接复用 `restoreFolder(当前层, …)`：当前层的直接子级就是还原计划要的那一层，
   * 而排除集已经表达了「哪些不要」——所以这里不需要自己拼装标签与分组。
   * 排除集是**跟随展示的层**的：换一层就自然换成那一层的选择，不会把别处的勾选悄悄带过来。
   *
   * 「建不建分组」不在这里决定，而是读上面那个「不建分组」复选框：
   * 它与「开到哪里」是两个独立维度，所以不做成两个按钮。
   */
  async function openSelection(kind: RestoreKind): Promise<void> {
    const folderId = archive.currentFolderId()
    if (flags.busy || !folderId) return
    flags.busy = true
    updateButtons()
    setStatus(status, '正在打开…', 'ok')

    const options: RestoreOptions = {
      target: kind,
      groupTabs: !noGroupCheck.checked,
      excludeBookmarkIds: archive.excluded()
    }

    try {
      await restoreFolder(folderId, options)
      setStatus(status, '', 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      await events.archiveChanged()
    }
  }

  /** 把外部拖进来的网址存成书签（从网页里拖过来的链接走这条路）。 */
  async function saveUrls(urls: readonly string[], parentId: string): Promise<void> {
    if (urls.length === 0) return
    flags.busy = true
    updateButtons()
    try {
      const ids: string[] = []
      for (const url of urls) ids.push((await createBookmark(parentId, url, url)).id)
      lastWrite = {folderIds: [], bookmarkIds: ids}
      setStatus(status, `已存下 ${ids.length} 个链接。`, 'ok')
      await events.archiveChanged()
      await refresh()
    } catch (error) {
      setStatus(status, `保存失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      updateButtons()
    }
  }

  // ———————————————— 拖拽 ————————————————

  function payloadOf(dragged: HTMLElement): DragPayload | undefined {
    const tabId = dragged.dataset.dragTab
    if (tabId !== undefined) return {kind: 'tab', tabId: Number(tabId)}
    const group = dragged.dataset.dragGroup
    if (group !== undefined) return {kind: 'group', index: Number(group)}
    const bookmark = dragged.dataset.dragBookmark
    if (bookmark !== undefined) return {kind: 'bookmark', id: bookmark}
    const folder = dragged.dataset.dragFolder
    if (folder !== undefined) return {kind: 'folder', id: folder}
    const separator = dragged.dataset.dragSeparator
    if (separator !== undefined) return {kind: 'separator', id: separator}
    return undefined
  }

  function draggedElement(event: DragEvent): HTMLElement | undefined {
    return (event.target as HTMLElement).closest<HTMLElement>(
      '[data-drag-tab], [data-drag-group], [data-drag-bookmark], [data-drag-folder], [data-drag-separator]'
    ) ?? undefined
  }

  function clearDropMarks(): void {
    for (const marked of element.querySelectorAll(
      '.is-drop-active, .is-dragging, .is-drop-before, .is-drop-after'
    )) {
      marked.classList.remove('is-drop-active', 'is-dragging', 'is-drop-before', 'is-drop-after')
    }
  }

  element.addEventListener('dragstart', (event) => {
    const dragged = draggedElement(event)
    if (!dragged || !event.dataTransfer) return
    const payload = payloadOf(dragged)
    if (!payload) return

    dragging = payload
    // 起点也要记：两栏都有收藏夹条目，而载荷里只有 id——两栏停在同一层时
    // 两边认得的是同一批 id，光看 id 真的分不出它来自哪一边。
    draggingPane = archivePaneAt(dragged)
    // 栏内是「移动」、跨栏也是「移动」（F7 之后两栏之间搬东西就是 `bookmarks.move`）；
    // 只有「拖到窗口里」是「开一份」，所以给 copyMove 让两边都收。
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))

    // 有网址时也写一份 `text/uri-list`，这样拖到浏览器别处（书签栏、地址栏）也有意义。
    const url = dragged.dataset.bookmarkUrl
    if (url) event.dataTransfer.setData('text/uri-list', url)
    dragged.classList.add('is-dragging')
  })

  element.addEventListener('dragend', () => {
    dragging = undefined
    draggingPane = undefined
    clearDropMarks()
  })

  /**
   * 这个元素属于哪一个收藏夹栏。
   *
   * 两栏的 `.box` 都写着 `data-drop-pane="archive"`（它说的是「这一格收收藏夹条目」），
   * 所以还得看它在哪个视图里。**不靠 id 前缀去猜**：那会把「模板怎么命名」变成隐式契约。
   */
  function archivePaneAt(target: HTMLElement): ArchivePane | undefined {
    const pane = target.closest<HTMLElement>('[data-drop-pane="archive"]')
    if (!pane) return undefined
    return pane.closest('#left-archive-view') ? leftArchive : archive
  }


  /** 左栏的落点：插到哪一格、归不归组。落在空白处则返回 `end`（追加到末尾）。 */
  function windowDropSpot(event: DragEvent): WindowDrop {
    const target = event.target as HTMLElement
    const tabRow = target.closest<HTMLElement>('[data-drop-row="tab"]')
    if (tabRow) {
      return {
        kind: 'tab',
        anchorIndex: Number(tabRow.dataset.tabIndex),
        after: spotIn(tabRow, event.clientY, false) === 'after',
        groupId: tabRow.dataset.tabGroup === undefined ? undefined : Number(tabRow.dataset.tabGroup)
      }
    }

    const groupRow = target.closest<HTMLElement>('[data-drop-row="group"]')
    if (groupRow) {
      const head = groupRow.querySelector<HTMLElement>('.group__head') ?? groupRow
      const tabs = [...groupRow.querySelectorAll<HTMLElement>('[data-drop-row="tab"]')]
      const first = tabs[0]
      const last = tabs.at(-1)
      if (!first || !last) return {kind: 'end'}
      const groupId = last.dataset.tabGroup === undefined ? undefined : Number(last.dataset.tabGroup)
      // 落在组的上/下缘 = 插到整组的前/后（一样带这个组）；中间 = 追加到组尾。
      const spot = spotIn(head, event.clientY, true)
      if (spot === 'before') return {kind: 'tab', anchorIndex: Number(first.dataset.tabIndex), after: false, groupId}
      return {kind: 'tab', anchorIndex: Number(last.dataset.tabIndex), after: true, groupId}
    }

    return {kind: 'end', groupId: lastWindowRowGroupId()}
  }

  /** 左栏最后一行属于哪个分组：拖到末尾时用它决定归不归组。 */
  function lastWindowRowGroupId(): number | undefined {
    const rows = windowList.querySelectorAll<HTMLElement>('[data-drop-row="tab"]')
    const value = rows[rows.length - 1]?.dataset.tabGroup
    return value === undefined ? undefined : Number(value)
  }



  /**
   * 一次拖动收不收，只看「拖的是什么」与「落在哪一栏」。
   *
   * 两栏其实**都收**内部拖动——栏内是挪、跨栏是存/开——所以这里只挡两件事：
   * 既不是内部载荷、也没带网址（比如拖了一段文字），以及**写不进书签树根的右栏**。
   * 剩下的区别只在「落下时做什么」与「提示画成什么样」，见 drop 处理器。
   *
   * 提示分三种，因为三种意图要看得出来不一样：
   *   左栏：插入线（插到某一行前/后），或整组高亮（追加进这个分组）；
   *   右栏：拖收藏夹条目过来时同上（那是「挪」）；拖标签过来时只有「进这一格 / 进这一层」（那是「存」）。
   */
  element.addEventListener('dragover', (event) => {
    const pane = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-pane]')
    if (!pane || !event.dataTransfer) return

    const toArchive = pane.dataset.dropPane === 'archive'
    // 落点要落到**具体哪一个**收藏夹栏上：两栏都有收藏夹，而它们的行长得一模一样。
    const target = toArchive ? archivePaneAt(pane) : undefined
    if (toArchive && !target) return
    const externalUrls = Array.from(event.dataTransfer.types).includes('text/uri-list')
    if (!dragging && !externalUrls) return
    if (target && !target.isWritable()) return

    const fromWindow = dragging?.kind === 'tab' || dragging?.kind === 'group'
    const fromArchive =
      dragging?.kind === 'bookmark' ||
      dragging?.kind === 'folder' ||
      dragging?.kind === 'separator'

    event.preventDefault()
    // 从窗口拖过去是「存一份」（复制），收藏夹之间是「搬」（移动）。
    event.dataTransfer.dropEffect = toArchive && fromWindow ? 'copy' : 'move'
    clearDropMarks()

    if (target && fromArchive) {
      // 挪一条收藏夹条目：同栏是排序，跨栏是搬去另一层——两处都是「行内三分法」。
      const spot = target.dropSpot(event)
      const samePane = draggingPane === target
      if (samePane && dragging && spot && !target.canDropAt(dragging, target.dropTargetId(spot))) {
        /*
         * 拖到自己或自己的子孙里：**整份拖拽直接拒收**。
         *
         * `dropEffect = 'none'` 不只是换个光标：按规范，拖拽的操作一旦是 none，
         * 浏览器连 `drop` 事件都不会派发。所以这个落点真的收不了东西。
         * 不这么做的话，用户会看到一条提示线、松手却什么都没发生。
         */
        event.dataTransfer.dropEffect = 'none'
        return
      }
      const folderRow = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-row="folder"]')
      if (spot?.kind === 'into' && folderRow) {
        folderRow.classList.add('is-drop-active')
        return
      }
      if (spot?.kind === 'here') {
        // 插入线画在**鼠标底下这一行**上：扁平渲染之后锚点就是它自己，不必再扫兄弟。
        const anchor = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-drop-row="bookmark"], [data-drop-row="folder"], [data-drop-row="separator"]'
        )
        if (anchor) {
          anchor.classList.add(spot.after ? 'is-drop-after' : 'is-drop-before')
          return
        }
      }
      // 落在行之间的空白处（或这一层是空的）：一律按「追加到末尾」提示。
      markEndDrop(target.list, pane)
      return
    }

    if (target) {
      // 存标签：落在文件夹行的中间就进那一层，否则进当前这一层（也就是追加到它的末尾）。
      const folderRow = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-row="folder"]')
      const inner = folderRow?.querySelector<HTMLElement>('.group__head') ?? folderRow
      const into = folderRow && inner && spotIn(inner, event.clientY, true) === 'into'
      if (into && folderRow) folderRow.classList.add('is-drop-active')
      else markEndDrop(target.list, pane)
      return
    }

    // 落到左栏。
    const spot = windowDropSpot(event)
    if (spot.kind === 'end') {
      markEndDrop(windowList, pane)
      return
    }
    const rows = [...windowList.querySelectorAll<HTMLElement>('[data-drop-row="tab"]')]
    const anchor = rows.find((row) => Number(row.dataset.tabIndex) === spot.anchorIndex)
    if (!anchor) {
      markEndDrop(windowList, pane)
      return
    }
    const groupRow = anchor.closest<HTMLElement>('[data-drop-row="group"]')
    if (groupRow && spotIn(groupRow.querySelector<HTMLElement>('.group__head') ?? groupRow, event.clientY, true) === 'into') {
      groupRow.classList.add('is-drop-active')
      return
    }
    anchor.classList.add(spot.after ? 'is-drop-after' : 'is-drop-before')
  })

  element.addEventListener('drop', async (event) => {
    const pane = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-pane]')
    if (!pane || !event.dataTransfer) return
    event.preventDefault()

    const payload = dragging
    const sourcePane = draggingPane
    const urls = event.dataTransfer
      .getData('text/uri-list')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))

    const toArchive = pane.dataset.dropPane === 'archive'
    const target = toArchive ? archivePaneAt(pane) : undefined
    // 落点在清掉标记之前算完：drop 的 target 与坐标都只在这一次事件里有效。
    const archiveSpot = target ? target.dropSpot(event) : undefined
    const windowSpot = toArchive ? undefined : windowDropSpot(event)

    dragging = undefined
    draggingPane = undefined
    clearDropMarks()

    if (target) {
      if (!target.isWritable()) return
      if (payload?.kind === 'bookmark' || payload?.kind === 'folder' || payload?.kind === 'separator') {
        // 收藏夹条目落到收藏夹上：
        //   同栏 = **挪**（同一个东西在它自己那一层里换位置）；
        //   跨栏 = 搬到对面那一层。两件事用的是同一个 API，只是目标层不同。
        if (sourcePane && sourcePane !== target) await moveAcrossPanes(target, payload, archiveSpot)
        else await target.moveNode(payload, archiveSpot)
        return
      }
      const parentId =
        archiveSpot?.kind === 'into' ? archiveSpot.folderId : target.currentFolderId()
      const children = payload ? childrenFor(payload) : []
      if (children.length > 0) await writeInto(parentId, children)
      else if (urls.length > 0) await saveUrls(urls, parentId)
      return
    }

    // 落到左栏。
    if (payload?.kind === 'tab' || payload?.kind === 'group') {
      await moveWindowTabs(payload, windowSpot ?? {kind: 'end'})
      return
    }
    if (
      payload?.kind === 'bookmark' ||
      payload?.kind === 'folder' ||
      payload?.kind === 'separator'
    ) {
      // 用**起点那一栏**的数据：能拖到窗口里的条目一定来自某个收藏夹实例，
      // 而两栏各有一份自己的树（`nodeIndex`），拿错一份就找不到那个 id。
      await openArchiveInto(sourcePane ?? archive, payload, windowSpot ?? {kind: 'end'})
      return
    }
    if (urls.length > 0) {
      for (const url of urls) await chrome.tabs.create({url, active: false})
      setStatus(status, `已打开 ${urls.length} 个链接。`, 'ok')
    }
  })

  /** 把拖拽载荷翻译成要写入的子级。 */
  function childrenFor(payload: DragPayload): WindowChild[] {
    if (payload.kind === 'group') {
      const child = windowChildren[payload.index]
      return child?.kind === 'group' ? [child] : []
    }
    if (payload.kind !== 'tab') return []

    for (const child of windowChildren) {
      if (child.kind === 'tab') {
        if (child.tab.tabId === payload.tabId) return [child]
        continue
      }
      const hit = child.tabs.find((tab) => tab.tabId === payload.tabId)
      // 组内的标签单独拖出来时存成散装书签，而不是把整组建一遍。
      if (hit) return [{kind: 'tab', tab: hit}]
    }
    return []
  }

  /** 载荷在窗口里的全部标签，以及它们在窗口里的下标（算插入位置要用）。 */
  function windowTabsFor(payload: DragPayload): TabSnapshot[] {
    if (payload.kind === 'group') {
      const child = windowChildren[payload.index]
      return child?.kind === 'group' ? [...child.tabs] : []
    }
    if (payload.kind !== 'tab') return []
    for (const child of windowChildren) {
      if (child.kind === 'tab' && child.tab.tabId === payload.tabId) return [child.tab]
      if (child.kind === 'group') {
        const hit = child.tabs.find((tab) => tab.tabId === payload.tabId)
        if (hit) return [hit]
      }
    }
    return []
  }

  /**
   * 把窗口里的标签挪到落点，并按落点所在的分组决定归组。
   *
   * 落点只表达两件事（插到哪一格、归不归组），于是「拖出分组」「拖进分组」「在组内换位置」
   * 都是同一条规则的不同结果，不需要各写一套。
   *
   * `tabs.move` 的 index 是**移动完成之后**的位置（`TabListInterface::MoveTab`：「Moves the tab to
   * index」，而同一族的 `MoveGroupTo` 才特意注明「assumes the group has already been removed」）。
   * 所以算插入位置时必须先把「原本排在锚点前面的、要拖的那几枚」减掉，否则向后拖会差一位。
   */
  async function moveWindowTabs(payload: DragPayload, drop: WindowDrop): Promise<void> {
    if (flags.busy) return
    const tabs = windowTabsFor(payload)
    if (tabs.length === 0) return
    const tabIds = tabs.map((tab) => tab.tabId)

    // 拖到自己身上 = 原地不动，而不是「与邻居交换」。
    // `tabs.move` 的 index 是**移动之后**的位置，所以「拖到自己这一行的下缘」会算出
    // 「自己 + 1」，真把标签往后挪一格；而用户看到的是自己根本没动过的位置（实测就是这一条）。
    if (drop.kind === 'tab' && tabs.length === 1 && drop.anchorIndex === tabs[0].index) return

    const insertAt =
      drop.kind === 'end'
        ? allWindowTabs().length - tabIds.length
        : anchorInsertIndex(drop.anchorIndex, drop.after, tabs.map((tab) => tab.index))

    flags.busy = true
    updateButtons()
    try {
      await chrome.tabs.move(tabIdArg(tabIds), {index: Math.max(0, insertAt)})
      // 归组跟着**落点所在的那一行**走：落点没有分组就拆组，有就归进去。
      // 于是「拖进分组」「拖出分组」「在组内换位置」都是同一条规则的结果。
      if (drop.groupId === undefined) await chrome.tabs.ungroup(tabIdArg(tabIds))
      else await chrome.tabs.group({tabIds: tabIdArg(tabIds), groupId: drop.groupId})
      setStatus(status, '已调整标签顺序。', 'ok')
    } catch (error) {
      setStatus(status, `调整失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      await refresh()
    }
  }

  /**
   * `chrome.tabs` 的类型把 `tabIds` 写成**非空**元组（`number | [number, ...number[]]`），
   * 而这里每个调用点前面都已经确认过「至少有一枚标签」，直接转换即可。
   */
  function tabIdArg(tabIds: readonly number[]): [number, ...number[]] {
    return tabIds as [number, ...number[]]
  }

  /**
   * 「插到第 anchor 枚标签前/后」对应的最终下标。
   *
   * `dragged` 是要挪的那几枚标签当前的下标：它们会先从数组里摘出去，
   * 所以在锚点之前的那几枚都会让锚点前移一格。
   */
  function anchorInsertIndex(anchor: number, after: boolean, dragged: readonly number[]): number {
    const removedBefore = dragged.filter((index) => index < anchor).length
    const anchorInRest = anchor - removedBefore
    return after ? anchorInRest + 1 : anchorInRest
  }

  /**
   * 落点解出「搬进哪一层」。
   *
   * 三种落点各有归属：`into` 是那个文件夹本身，`here` 是**它所在的那一层**（展开子级之后
   * 这两者不是一回事），都不是就是目标栏当前这一层（追加到末尾）。
   * 返回的 `index` 只对 `here` 有意义，而且直接就是 `bookmarks.move` 要的那个坐标系
   * ——新旧父级不同，没有「同父下移要先减一」那回事。
   */
  function destOf(target: ArchivePane, spot: ArchiveDrop | undefined): {id: string; index?: number} {
    if (spot?.kind === 'into') return {id: spot.folderId}
    if (spot?.kind === 'here') return {id: spot.parentId, index: spot.index}
    return {id: target.currentFolderId()}
  }

  /** 某一层显示出来的名字（搬完报一句「挪到哪儿了」用）。 */
  function destLabel(target: ArchivePane, destId: string): string {
    return target.folderTitle(destId) ?? target.currentFolderTitle()
  }

  /**
   * 把一条收藏夹条目从一栏搬到另一栏——F7 的主要动作。
   *
   * 与栏内排序共用同一个 API（`chrome.bookmarks.move`），差别只在「目标层属于另一栏」。
   * 所以这条路上没有 `canDropAt`：它查的是**本栏**那份父子索引，跨栏时里面根本没有源这一侧的节点。
   * 于是自己沿目标那一层的父链走一遍（`getNodePath()` 就是那条链），命中就拒收——
   * 让 Chrome 去抛错会在界面上留下「拖了但没动」而没有任何解释的痕迹。
   */
  async function moveAcrossPanes(
    target: ArchivePane,
    payload: {kind: 'bookmark' | 'folder' | 'separator'; id: string},
    spot: ArchiveDrop | undefined
  ): Promise<void> {
    if (flags.busy) return
    const dest = destOf(target, spot)
    if (!dest.id) return

    if (payload.kind === 'folder' && (await getNodePath(dest.id)).some((node) => node.id === payload.id)) {
      setStatus(status, '不能把文件夹挪进它自己里面。', 'error')
      return
    }

    // 不置灰按钮：搬一条几乎是瞬时的（与栏内排序同一个理由），置灰只会让那排按钮闪一下。
    flags.busy = true
    try {
      await chrome.bookmarks.move(payload.id, {parentId: dest.id, index: dest.index})
      setStatus(status, `已挪到「${destLabel(target, dest.id)}」。`, 'ok')
    } catch (error) {
      setStatus(status, `移动失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      await events.archiveChanged()
      await refresh()
    }
  }

  /** 把一份搬走清单说成人话（按钮的悬停提示与状态行都用它）。 */
  function describeItems(items: readonly MoveItem[]): string {
    const folders = items.filter((item) => item.kind === 'folder').length
    const bookmarks = items.length - folders
    // 两种混在一起时写「A 个文件夹与 B 枚书签」：数字与前面的单位之间本来就留一个空格，
    // 连起来写会变成「1 个文件夹与1 枚书签」，读起来像是漏字。
    if (folders === 0) return `${bookmarks} 枚书签`
    if (bookmarks === 0) return `${folders} 个文件夹`
    return `${folders} 个文件夹与 ${bookmarks} 枚书签`
  }

  /**
   * 把某一栏**勾选的东西**搬到另一栏当前这一层（中间那排「移动过去 / 移动过来」）。
   *
   * 搬什么由 `keptItems()` 决定，而那份清单与行上的勾选框严格同一口径：
   * **文件夹整选 = 搬文件夹本身**（连子树），**里面有没勾的 = 只搬勾上的那几枚书签**。
   * 所以「取消勾选其中几枚」这件事本身就改变了搬的单位，不需要再多给一个选项——
   * 而用户能从行上那个三态勾选框直接看到自己在哪一种情况里。
   *
   * 三种情况会留在原地，而且都要说出来（不说的话用户看到的是「点了没反应」）：
   * - **本来就在这一层的**：两栏停在同一层是很常见的状态（都是打开界面时的起点），
   *   而「搬到同一个父级」在 `bookmarks.move` 里是**追加到末尾**——
   *   用户要的不是「把这几个排到最后」，所以跳过。
   *   （**拖拽那条路不跳**：拖动指的是具体位置，同层重排本来就是它的正当用法。）
   * - **要被搬进它自己里面的文件夹**：另一栏完全可以导航进那个文件夹，那时 `move` 会成环。
   * - 一条都搬不动时整件事直接说不做，而不是报「已移动 0 条」。
   *
   * 一条一条地调（省略 `index` 就是追加到末尾），所以搬过去的顺序与勾选时的顺序一致。
   */
  async function moveSelection(source: ArchivePane, target: ArchivePane): Promise<void> {
    if (flags.busy) return
    const destId = target.currentFolderId()
    if (!destId || !target.isWritable()) return
    const items = source.keptItems()
    if (items.length === 0) return

    // 目的地的祖先链：文件夹落在它里面就会成环（`move` 会失败）。
    const destPath = new Set((await getNodePath(destId)).map((node) => node.id))
    const movable: MoveItem[] = []
    let here = 0
    let cyclic = 0
    for (const item of items) {
      if (item.kind === 'folder' && destPath.has(item.id)) cyclic++
      else if (source.parentOf(item.id) === destId) here++
      else movable.push(item)
    }

    const destName = target.currentFolderTitle()
    if (movable.length === 0) {
      setStatus(
        status,
        cyclic > 0 ? '不能把文件夹搬进它自己里面。' : `这些已经在「${destName}」里了。`,
        cyclic > 0 ? 'error' : 'ok'
      )
      return
    }

    flags.busy = true
    updateButtons()
    try {
      for (const item of movable) await chrome.bookmarks.move(item.id, {parentId: destId})
      const notes: string[] = []
      if (here > 0) notes.push(`${here} 条本来就在这一层`)
      if (cyclic > 0) notes.push('文件夹不能搬进它自己里面')
      setStatus(
        status,
        `已把 ${describeItems(movable)}移到「${destName}」。${notes.length > 0 ? `（${notes.join('；')}）` : ''}`,
        'ok'
      )
    } catch (error) {
      setStatus(status, `移动失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      await events.archiveChanged()
      await refresh()
    }
  }



  /**
   * 把收藏夹里的一条书签或一个文件夹按落点开成标签页。
   *
   * 这是「把这一条放到窗口里的某个位置」：先按落点算出要插入的下标，再逐个 `tabs.create({index})`——
   * 创建不需要「减掉自己」的修正，因为被插入的东西原本不在这个窗口里。
   *
   * 文件夹开成一组标签，并用文件夹名当分组名（与「文件夹 ⇄ 分组」这个对应关系一致）。
   * 标签同样会在导航提交后被 `discard` 卸掉：拖一个几十枚书签的文件夹过来，
   * 不至于把浏览器同时点燃几十个页面。
   */
  async function openArchiveInto(
    source: ArchivePane,
    payload: DragPayload,
    drop: WindowDrop
  ): Promise<void> {
    if (flags.busy) return
    const items = source.openItems(payload)
    if (items.length === 0) {
      setStatus(status, '这一条里没有可以打开的网址。', 'error')
      return
    }

    const count = allWindowTabs().length
    const startAt = drop.kind === 'end' ? count : drop.after ? drop.anchorIndex + 1 : drop.anchorIndex

    flags.busy = true
    updateButtons()
    setStatus(status, '正在打开…', 'ok')
    try {
      const tabIds: number[] = []
      for (const [offset, item] of items.entries()) {
        const tab = await chrome.tabs.create({url: item.url, index: startAt + offset, active: false})
        if (tab.id !== undefined) tabIds.push(tab.id)
      }

      // 文件夹开的标签收进一个同名分组；单条书签就让它当散装标签。
      const groupTitle = payload.kind === 'folder' ? (source.folderTitle(payload.id) ?? '') : ''
      if (groupTitle && tabIds.length > 0) {
        const groupId = await chrome.tabs.group({tabIds: tabIdArg(tabIds)})
        await chrome.tabGroups.update(groupId, {title: groupTitle})
      }

      await discardCommittedTabs(tabIds, {keepLoadedTabId: tabIds[0]})
      setStatus(status, `已打开 ${tabIds.length} 个标签页。`, 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      await refresh()
    }
  }


  // ———————————————— 勾选 ————————————————


  windowList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const loadButton = target.closest<HTMLButtonElement>('[data-load-tab]')
    if (loadButton?.dataset.loadTab !== undefined) {
      void loadTab(Number(loadButton.dataset.loadTab))
      return
    }
    const releaseButton = target.closest<HTMLButtonElement>('[data-release-tab]')
    if (releaseButton?.dataset.releaseTab !== undefined) {
      void releaseTab(Number(releaseButton.dataset.releaseTab))
      return
    }
    const closeButton = target.closest<HTMLButtonElement>('[data-close]')
    if (closeButton?.dataset.close !== undefined) {
      pendingClose = parseCloseKey(closeButton.dataset.close)
      renderWindow()
      return
    }
    const confirmClose = target.closest<HTMLButtonElement>('[data-confirm-close]')
    if (confirmClose?.dataset.confirmClose !== undefined) {
      void closeTarget(parseCloseKey(confirmClose.dataset.confirmClose))
      return
    }
    if (target.closest('[data-cancel-close]')) {
      pendingClose = undefined
      renderWindow()
      return
    }
    const switchButton = target.closest<HTMLButtonElement>('[data-switch-tab]')
    if (switchButton?.dataset.switchTab !== undefined) {
      void switchToTab(Number(switchButton.dataset.switchTab))
      return
    }
    toggleRowFromClick(windowList, event)
  })

  /**
   * 切到某一枚标签（左栏行尾的「打开」）。
   *
   * 光 `tabs.update({active})` 只在**那一枚标签所在的窗口**里生效：主界面与它在不同的
   * 浏览器窗口时，视口不会跟过去，看着就是「点了没反应」。所以还要把那扇窗口提到最前。
   */
  async function switchToTab(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.update(tabId, {active: true})
      const windowId = tab?.windowId
      if (windowId !== undefined) await chrome.windows.update(windowId, {focused: true})
    } catch (error) {
      setStatus(status, `切换失败：${errorText(error)}`, 'error')
    }
  }

  /**
   * 在后台把一枚已卸载的标签读出来（左栏行尾的「加载」）。
   *
   * 对卸载掉的标签，`tabs.reload()` 就是「加载」：卸载时内容被丢掉、地址还记着，
   * 重新加载它**不会切走**当前这一页（`active` 根本不动）——这正是这一栏要的动作。
   * 「打开」也能让它加载，但那是**跳过去**：想先把几页读出来接着干别的就不行了。
   *
   * 这条路是 Chrome 自己的 API 测试覆盖过的（`tabs/basics/discarded/discarded.js`：
   * 「Tab is already discarded」→ `chrome.tabs.reload(id)` → 断言 `changeInfo.discarded` 为假）。
   *
   * 但要先说清楚**它能做到哪一步**：它只把「开始加载」这件事说出来。
   * 网页标题是页面自己给的，什么时候给由网站决定——重 SPA（x.com 这类）在标签不可见时
   * 往往走不到设置标题那一步，那些页面的标题要等用户切过去才更新。
   * 这时行尾会停在「加载中」（而不是按钮无声消失），所以看上去是「还在加载」而不是「点了没反应」。
   * 状态行也会说一句——不是报账，而是因为标题可能一直不来，得先说清楚请求已经发出去了。
   */
  async function loadTab(tabId: number): Promise<void> {
    try {
      await chrome.tabs.reload(tabId)
      setStatus(status, '已在后台加载这一页；标题要等页面自己给出。', 'ok')
    } catch (error) {
      setStatus(status, `加载失败：${errorText(error)}`, 'error')
    }
  }

  /**
   * 把一枚已加载的标签的内存交回去（左栏行尾的「释放」）。
   *
   * 与「加载」是同一个 API 的逆方向：`chrome.tabs.discard()` 丢掉页面内容、保留地址与标题，
   * 点开时才重新加载。这一栏是活着的标签的清单，几十枚页面同时驻留内存时，
   * 「我还想看这几个，其余先放掉」是常有的需要。
   *
   * 两个不做的事：
   *
   * - **不给活动标签这个按钮**（见 `statusSlotMarkup()`）：它就在屏幕上，卸载马上会被读回来。
   *   注意这不是 API 限制——`tabs.discard` 用的是 EXTERNAL 理由，连活动标签都是允许的
   *   （`DiscardEligibilityPolicyTest.TestCannotDiscardActiveTab` 里只有 URGENT / PROACTIVE /
   *   SUGGESTED 被算作受保护），所以这一条是**我们自己的选择**，不是防御。
   * - **不写成功提示**：卸载 / 解除卸载由 Chrome 派发 `onUpdated{status, discarded}`，
   *   那一行自己会变成「加载」，比文字更直接。
   *
   * 失败倒是要说话：它是有真实拒绝条件的（已是 unloaded、没有 WebContents、
   * 有未提交的导航等待提交等），而且此时 Chrome 会抛 `Cannot discard tab with id: N`。
   */
  async function releaseTab(tabId: number): Promise<void> {
    try {
      await chrome.tabs.discard(tabId)
    } catch (error) {
      setStatus(status, `释放失败：${errorText(error)}`, 'error')
    }
  }

  /**
   * 一个分组里**全部**的标签 id。
   *
   * 不能直接用界面上那个分组桶里的 tabId：`snapshotCurrentWindow()` 会把
   * **浏览器内部页面**（`chrome://` / 扩展页面 / `devtools://`…）跳过，因为它们存不成书签。
   * 存的时候跳过是对的，**关的时候跳就不对了**——关掉一个装着 `chrome://newtab` 的分组之后，
   * 那一枚活了下来，于是**分组也跟着活了下来**（一个分组只要还剩一枚标签就不会消失）。
   * 用户看到的就是「关了，分组还在」。
   *
   * 所以这里改成按 groupId 问浏览器要全量名单（`tabs.query({groupId})`，Chrome 88+）。
   */
  async function allTabIdsInGroup(groupId: number): Promise<number[]> {
    const tabs = await chrome.tabs.query({groupId})
    return tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]))
  }

  /**
   * 关闭左栏里的一条标签或一整个分组（第二步确认之后才走到这里）。
   *
   * **不可逆**，所以只有两步确认这一道门：关闭本身调 `chrome.tabs.remove`，
   * 而它没有「软关闭」这回事。
   *
   * 分组**先解散（`tabs.ungroup`）再关闭（`tabs.remove`）**，顺序是有意的：
   * 解散让这些标签先**离开**那个分组，于是分组是因为「空了」而消失，而不是因为「被关闭」。
   * 这两条路径在 Chrome 里是分开处理的——关闭会留下「已保存标签页群组」的存档，
   * 而 Chrome 菜单里那个「删除群组」删的正是那份存档。**扩展 API 里没有直接删存档的接口**
   * （`chrome/common/extensions/` 里搜不到一处 `saved_tab_groups`，它存在 sync 层、不在书签树里），
   * 但下面这条「先解散」的路径能**间接**达到同样的结果。
   *
   * **已实测确认（2026-10-03，真实 Chrome）**：这个顺序确实会让菜单里那份存档也消掉——
   * 与浏览器菜单里的「删除群组」结果一致。机制没有查到确切的代码分支，但**顺序是关键**：
   * 反过来先 `remove` 就只会得到那个「关闭」行为（存档保留）。所以这两行不能为了
   * 「看着更顺」而交换，也不能图省事删掉 `ungroup`。
   *
   * 关闭之后**不等去抖就立刻重读窗口**：`onRemoved` 那条路要 120 ms（`WINDOW_REFRESH_DEBOUNCE_MS`），
   * 而这一段时间里那一行还留在屏幕上、且停在新出现的「确认关闭」状态上——
   * 看着就像「点了没反应」。直接 `refreshWindowOnly()` 一次只多一次 `tabs.query`。
   */
  async function closeTarget(target: {kind: 'tab'; tabId: number} | {kind: 'group'; index: number}): Promise<void> {
    if (flags.busy) return
    const isGroup = target.kind === 'group'
    let tabIds: number[] = []
    if (target.kind === 'tab') {
      tabIds = [target.tabId]
    } else {
      const child = windowChildren[target.index]
      // 分组里那一枚的 groupId 取组内第一枚即可（整组同属一个分组）。
      const groupId = child?.kind === 'group' ? child.tabs[0]?.groupId : undefined
      try {
        tabIds = groupId === undefined ? [] : await allTabIdsInGroup(groupId)
      } catch (error) {
        pendingClose = undefined
        renderWindow()
        setStatus(status, `关闭失败：${errorText(error)}`, 'error')
        return
      }
    }
    if (tabIds.length === 0) {
      pendingClose = undefined
      renderWindow()
      return
    }

    // 不置灰按钮：关闭几乎是瞬时的，而「置灰 → 恢复」会让一整排按钮闪一下
    // （与 `moveArchiveNode` 同一个理由）。`busy` 只当防重入的闩。
    flags.busy = true
    pendingClose = undefined
    // 上面已经挡掉了空数组，而 `ungroup` 的签名要求「至少一个 id」（`[number, ...number[]]`），
    // 所以这里可以安全地断言一次。
    const ids = tabIds as [number, ...number[]]
    // 走到哪一步了：解散成功而关闭失败时要说清楚，否则用户看到「关闭失败」
    // 会以为什么都没发生，而分组其实已经被解散了。
    let ungrouped = false
    try {
      if (isGroup) {
        await chrome.tabs.ungroup(ids)
        ungrouped = true
      }
      await chrome.tabs.remove(ids)
      // 从选中集里剔掉：虽然 `refreshWindowOnly()` 也会剪（那一刻它们已经不在窗口里了），
      // 但这里先剔一次，这一行的话更直白。
      for (const tabId of tabIds) windowSelected.delete(tabId)
      // 报**真实枚数**：它可能比界面上看到的多（内部页面不在列表里），
      // 说「已关闭 5 枚」比说「已关闭 4 枚」诚实，也让用户明白分组为什么没了。
      const what = tabIds.length === 1 ? '1 枚标签页' : `${tabIds.length} 枚标签页`
      setStatus(status, isGroup ? `已解散分组，并关闭了 ${what}。` : `已关闭 ${what}。`, 'ok')
    } catch (error) {
      setStatus(
        status,
        ungrouped
          ? `分组已解散，但关闭标签页失败：${errorText(error)}`
          : `关闭失败：${errorText(error)}`,
        'error'
      )
    } finally {
      flags.busy = false
      await refreshWindowOnly()
    }
  }

  element.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement

    const tabId = input.dataset.windowTab
    if (tabId !== undefined) {
      if (input.checked) windowSelected.add(Number(tabId))
      else windowSelected.delete(Number(tabId))
      syncWindowStates()
      return
    }

    const groupIndex = input.dataset.windowGroup
    if (groupIndex !== undefined) {
      const child = windowChildren[Number(groupIndex)]
      if (child?.kind === 'group') {
        // 不读原生取反的结果：部分选择时它会变成「全不选」，与惯例相反。
        const wantAll = nextSelectAll(triState(windowKeptTabs(child.tabs).length, child.tabs.length))
        for (const tab of child.tabs) {
          if (wantAll) windowSelected.add(tab.tabId)
          else windowSelected.delete(tab.tabId)
        }
      }
      syncWindowStates()
      return
    }

    // 收藏夹那一栏的勾选（三态、叶子、以及「只有它认识这个输入框」）全在实例里。
    // 面板只把事件递给**输入框所在的那一栏**——不问它「是不是你的、不是再问另一个」：
    // `data-archive-item` 两栏都有，第一个实例会把它当成自己的，而它属于另一栏。
    const owner = input.closest('#left-archive-view') ? leftArchive : archive
    if (owner.handleChange(input)) return
  })

  // ———————————————— 按钮 ————————————————

  /**
   * 左栏那枚两档控件。
   *
   * 点击不是「命令」而是「换一档」，所以两个按钮各管自己那一档；当前档由 `applyMode()` 标出来。
   */
  for (const button of element.querySelectorAll<HTMLButtonElement>('.mode')) {
    button.addEventListener('click', () => void setMode(button.dataset.mode as Mode))
  }

  // 两栏互相搬（只在收藏夹档下出现）。箭头指哪边，就把勾选的东西送到哪边。
  moveRightButton.addEventListener('click', () => void moveSelection(leftArchive, archive))
  moveLeftButton.addEventListener('click', () => void moveSelection(archive, leftArchive))

  // 初始那一档要在建完两个实例之后摆一次：模板里写的是窗口档，但可见性与
  // 按钮的 disabled / 文案都得按当前状态算一遍。
  applyMode()

  // 「存过去」写的是**当前展示的这一层**，不是某个固定的起点：右栏是一个可导航的浏览器，
  // 「站在哪儿就往哪儿存」才说得通。书签树的根不接受写入，用 `isWritable()` 挡住。
  saveButton.addEventListener('click', () => {
    const parentId = archive.currentFolderId()
    if (archive.isWritable()) void writeInto(parentId, keptWindowChildren())
  })

  // 两个打开入口按「这一次要开到哪里」分：当前窗口 / 新窗口。
  // 「建不建分组」是另一个维度，由上面那个复选框说了算（见 openSelection）。
  // 它们与拖拽共用 restoreFolder，口径不会分叉。
  openButton.addEventListener('click', () => void openSelection('currentWindow'))
  openWindowButton.addEventListener('click', () => void openSelection('newWindow'))
  undoButton.addEventListener('click', () => void undo())

  return {
    element,
    refresh,
    // 两栏的导航都暴露出来，但**方向不同**：右栏那个一直有效，
    // 左栏那个在窗口档下没有意义（它那时装的是标签），所以 `navigateToLeft` 会先切档。
    navigateTo: archive.navigateTo,
    navigateToLeft,
    currentFolderId: () => archive.currentFolderId(),
    leftFolderId: () => leftArchive.currentFolderId()
  }
}
