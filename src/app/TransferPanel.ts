import {
  createBookmark,
  createFolder,
  getBookmarksBarId,
  getNodePath,
  getSubTree,
  isRealBookmark,
  realBookmarks,
  removeSubTree,
  updateNode
} from '../shared/bookmarks'
import {
  planWindowChildren,
  snapshotCurrentWindow,
  writeChildren,
  type WindowChild
} from '../shared/capture'
import {formatTimestamp, sanitizeFolderName} from '../shared/naming'
import {discardCommittedTabs, openInBookmarkManager, restoreFolder} from '../shared/restore'
import {loadSettings} from '../shared/settings'
import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {BookmarkNode, RestoreOptions, TabSnapshot} from '../shared/types'
import {
  SEPARATOR_LABELS,
  hostnameOf,
  isInternalUrl,
  isSeparatorUrl,
  separatorKind,
  separatorTitle,
  separatorUrlOf,
  toggledSeparatorKind,
  type SeparatorKind
} from '../shared/urls'
import {
  createPanelElement,
  createSelectAll,
  errorText,
  nextSelectAll,
  q,
  setStatus,
  triState,
  type AppEvents,
  type Panel
} from './dom'
import {openBookmarkDialog} from './BookmarkDialog'
import {FOLDER_ICON, PIN_ICON, REFRESH_ICON, VERT_LINE_ICON, plusIcon} from './icons'

/** Chrome 本地 favicon 缓存端点：读缓存、不联网。 */
const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

/**
 * 内建拖拽载荷的类型名。
 *
 * 用它而不是 `text/plain` 是为了区分「本项目内部的拖动」与「从网页拖来的链接」：
 * 后者只带 `text/uri-list`，处理方式不同（按网址存成书签，而不是按键找书签）。
 */
const DRAG_TYPE = 'application/x-tabfurl'

/** 拖动来源：左栏的标签/分组，或右栏的一条书签/文件夹/分隔线。 */
type DragPayload =
  | {kind: 'tab'; tabId: number}
  | {kind: 'group'; index: number}
  | {kind: 'bookmark'; id: string}
  | {kind: 'folder'; id: string}
  | {kind: 'separator'; id: string}

type RestoreKind = 'newWindow' | 'currentWindow'

/**
 * 一行内部的落点。上缘 = 插到前面，下缘 = 插到后面，中间 = **进入**（只对文件夹行与分组行有意义）。
 */
type DropSpot = 'before' | 'into' | 'after'

/** 左栏的落点。`end` 表示落在末尾（空白处），那时归组看**最后一行**属于哪个分组。 */
type WindowDrop =
  | {kind: 'tab'; anchorIndex: number; after: boolean; groupId?: number}
  | {kind: 'end'; groupId?: number}

/** 右栏的落点。`into` 进某个子文件夹，`here` 插到当前这一层的某个下标。 */
type ArchiveDrop = {kind: 'into'; folderId: string} | {kind: 'here'; index: number}

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

const TEMPLATE = `
  <div class="split">
    <section class="col">
      <header class="col__head">
        <h2 class="col__title">当前窗口 <span class="badge" id="window-count">0</span></h2>
      </header>
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
    </div>

    <section class="col">
      <header class="col__head">
        <h2 class="col__title">收藏夹 <span class="badge" id="archive-count">0</span></h2>
      </header>
      <!--
        收藏文件夹的 chip 栏由 App 挂进这个位置（见导出常量 FAVORITE_HOST_ID）：
        面板只提供位置，不知道该挂什么——它要是自己 import 那个模块，两个界面模块就栓到一起了。
        它**自己占一行**而不是挤在表头里：「收藏这一层」+ 添加下拉框 + 若干 chip 一起放进表头，
        窄窗口下会把标题挤没。
      -->
      <div class="row row--compact" id="${FAVORITE_HOST_ID}"></div>
      <div class="row row--compact" id="archive-all-host"></div>
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
            <nav class="path" id="archive-path" aria-label="当前所在的收藏夹位置"></nav>
            <div class="row row--compact">
              <button type="button" class="btn btn--ghost btn--sm" id="new-folder-btn">＋ 新建文件夹</button>
              <button type="button" class="btn btn--ghost btn--sm" id="new-separator-btn"
                      title="在当前位置插一条分隔线（竖线，给横向排列的书签栏用）">＋ 分隔线</button>
              <button type="button" class="btn btn--ghost btn--sm" id="new-gap-btn"
                      title="在当前位置插一条间隔（横线，给竖向排列的列表用）">＋ 间隔</button>
              <button type="button" class="btn btn--ghost btn--sm" id="open-root-btn" hidden>打开书签管理器</button>
            </div>
          </div>
          <!-- 在书签树根上时写入入口会是灰的，用一句话说明为何以及怎么退出去。 -->
          <p class="box__note" id="archive-note" hidden></p>
        </div>
        <ul class="list" id="archive-list">
          <li class="skeleton" aria-hidden="true"></li>
          <li class="skeleton" aria-hidden="true"></li>
          <li class="skeleton" aria-hidden="true"></li>
          <li class="skeleton" aria-hidden="true"></li>
        </ul>
      </div>
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
  /** 跳到某一层。收藏文件夹 chip 用它——导航归面板，外部只发意图。 */
  navigateTo(folderId: string): Promise<void>
  /** 用户正站在哪一层（空串表示还没落到任何一层）。「收藏这一层」现问一次它。 */
  currentFolderId(): string
}
export function createTransferPanel(events: AppEvents): TransferPanel {
  const element = createPanelElement('transfer')
  element.innerHTML = TEMPLATE

  const windowList = q<HTMLUListElement>(element, '#window-list')
  const archiveList = q<HTMLUListElement>(element, '#archive-list')
  const windowCount = q<HTMLSpanElement>(element, '#window-count')
  const archiveCount = q<HTMLSpanElement>(element, '#archive-count')
  const archivePath = q<HTMLElement>(element, '#archive-path')
  const archiveNote = q<HTMLParagraphElement>(element, '#archive-note')
  const saveButton = q<HTMLButtonElement>(element, '#save-btn')
  const saveLabel = q<HTMLSpanElement>(element, '#save-label')
  const openButton = q<HTMLButtonElement>(element, '#open-btn')
  const openLabel = q<HTMLSpanElement>(element, '#open-label')
  const openWindowButton = q<HTMLButtonElement>(element, '#open-window-btn')
  const openWindowLabel = q<HTMLSpanElement>(element, '#open-window-label')
  const undoButton = q<HTMLButtonElement>(element, '#undo-btn')
  const noGroupCheck = q<HTMLInputElement>(element, '#no-group-check')
  const newFolderButton = q<HTMLButtonElement>(element, '#new-folder-btn')
  const newSeparatorButton = q<HTMLButtonElement>(element, '#new-separator-btn')
  const newGapButton = q<HTMLButtonElement>(element, '#new-gap-btn')
  const openRootButton = q<HTMLButtonElement>(element, '#open-root-btn')
  const status = q<HTMLSpanElement>(element, '#status')

  const windowSelectAll = createSelectAll(q<HTMLDivElement>(element, '#window-all-host'), {
    describe: (kept, total) =>
      total === 0
        ? '当前窗口没有可保存的标签页'
        : kept === total
          ? `已全选 ${total} 个标签页`
          : `已选 ${kept} / ${total} 个标签页`,
    onChange: (wantAll) => {
      if (wantAll) windowExcluded.clear()
      else for (const tab of allWindowTabs()) windowExcluded.add(tab.tabId)
      syncWindowStates()
    }
  })

  /**
   * 左栏的刷新按钮。
   *
   * 它追着全选框那一行摆，但**不紧紧跟在文字后面**：那行文字会随着勾选从
   * 「已全选 3 个标签页」变成「已选 2 / 127 个标签页」，紧跟就会左右滑动。
   * `margin-left: auto` 把它钉在这一行的右端，位置与文字长度无关。
   *
   * 它**不置灰**（哪怕 `busy`）：这是用户的手动退路，正因为「界面看着不对」才点它。
   */
  const windowRefreshButton = document.createElement('button')
  windowRefreshButton.type = 'button'
  windowRefreshButton.id = 'window-refresh-btn'
  windowRefreshButton.className = 'btn btn--ghost btn--icon'
  windowRefreshButton.title = '重新读取当前窗口的标签页'
  windowRefreshButton.setAttribute('aria-label', '重新读取当前窗口的标签页')
  windowRefreshButton.innerHTML = REFRESH_ICON
  q<HTMLDivElement>(element, '#window-all-host').append(windowRefreshButton)

  windowRefreshButton.addEventListener('click', async () => {
    await refresh()
    setStatus(status, '已刷新。', 'ok')
  })

  const archiveSelectAll = createSelectAll(q<HTMLDivElement>(element, '#archive-all-host'), {
    describe: (kept, total) => {
      // 与左栏同一套嗍词（「已选 K / N 个标签页」）。
      // 不说「收藏夹里共 N 枚」：勾选跟着展示的层走，「打开 (N)」也只算这一层，写成整个收藏夹会与按钮对不上。
      if (total === 0) return '这一层没有可打开的标签页'
      return kept === total ? `已全选 ${total} 个标签页` : `已选 ${kept} / ${total} 个标签页`
    },
    onChange: (wantAll) => {
      for (const id of archiveBookmarkIds()) {
        if (wantAll) archiveExcluded.delete(id)
        else archiveExcluded.add(id)
      }
      syncArchiveStates()
    }
  })

  /**
   * 收藏的文件夹（书签树 id，按用户排的顺序）。
   *
   * 它们只是**快捷方式**，不是边界：右栏可以在书签树里任意导航（包括走到收藏**上面**的层），
   * 写入跟的一直是当前展示的那一层。顺序有意义——第一个可用的是打开界面时的落点。
   */
  let favoriteFolderIds: string[] = []
  /**
   * 右栏当前展示的哪一层。
   *
   * 右栏不是一棵可展开的树，而是一个**可导航的浏览器**：双击子文件夹行进去，`↑ 上一层` 退回来，
   * 面包屑可以跳到路径上的任意一层。理由见 `docs/design.md`：层级一深，缩进链会把面板压成一条细缝，
   * 而「上一层」是 O(1) 的退路，缩进不是。
   */
  let viewFolderId = ''
  /** 当前展示的文件夹从树根到自身的完整路径（含自身），用于面包屑与「上一层」。 */
  let viewPath: {id: string; title: string}[] = []
  /**
   * 面包屑上一次渲染用的签名。
   *
   * 初值是 `undefined` 而不是空串：`viewPath` 为空时签名也是空串，一撞就会把「第一次
   * 该画那句『还没落到任何一层』」当成「内容没变」跳过。
   */
  let lastPathSignature: string | undefined
  let windowChildren: WindowChild[] = []
  let archiveChildren: BookmarkNode[] = []
  /**
   * 左栏上一次渲染用的签名。
   *
   * 初次为 `undefined`（还没渲染过，列表里是骨架），所以第一次一定会建 DOM。
   */
  let windowSignature: string | undefined
  /** 左栏被勾掉的标签 id（保存侧默认全选，所以记排除）。 */
  const windowExcluded = new Set<number>()
  /** 右栏被勾掉的书签 id（打开侧默认全不勾，所以记排除 + 一份「见过的」）。 */
  const archiveExcluded = new Set<string>()
  const knownBookmarks = new Set<string>()
  let pendingDeleteId: string | undefined
  let renaming: {id: string; committed: boolean} | undefined
  /** 撤销目标：最近一次写入新建的 id。只存在内存里（见 docs/design.md）。 */
  let lastWrite: {folderIds: string[]; bookmarkIds: string[]} | undefined
  /** 正在拖的是什么；`dragover` 靠它决定收不收。 */
  let dragging: DragPayload | undefined
  /** 上一次跳转的时刻，用于吞掉双击带来的第二次跳转（见 `navigateTo`）。 */
  let lastNavigationAt = 0
  let busy = false

  // ———————————————— 左栏 ————————————————

  function allWindowTabs(): TabSnapshot[] {
    return windowChildren.flatMap((child) =>
      child.kind === 'tab' ? [child.tab] : [...child.tabs]
    )
  }

  function windowKeptTabs(tabs: readonly TabSnapshot[]): TabSnapshot[] {
    return tabs.filter((tab) => !windowExcluded.has(tab.tabId))
  }

  /** 左栏里「还会被存下去」的子级：整组被勾掉就不写这个文件夹。 */
  function keptWindowChildren(): WindowChild[] {
    return windowChildren.flatMap<WindowChild>((child) => {
      if (child.kind === 'tab') return windowExcluded.has(child.tab.tabId) ? [] : [child]
      const tabs = windowKeptTabs(child.tabs)
      return tabs.length > 0 ? [{...child, tabs}] : []
    })
  }

  /**
   * 一条标签行。
   *
   * 三个 data 属性各有用处：`data-row` 供「点整行切换勾选」找到勾选框；
   * `data-tab-index` 与 `data-tab-group` 供拖拽算落点（插到哪儿、归哪个组）。
   *
   * 右侧的「打开」是**切过去**（`active: true` + 聚焦窗口），不是「打开一个新标签」——
   * 这一栏是活着的标签的清单，对着它点一条就是要跳到那一条上去。
   */
  function tabRowMarkup(tab: TabSnapshot): string {
    const host = hostnameOf(tab.url) ?? tab.url
    const groupAttr = tab.groupId === undefined ? '' : ` data-tab-group="${tab.groupId}"`
    return `
      <li class="item leaf" draggable="true" data-row data-drop-row="tab"
          data-tab-index="${tab.index}"${groupAttr} data-drag-tab="${tab.tabId}">
        <input type="checkbox" data-window-tab="${tab.tabId}" />
        ${faviconMarkup(tab.url, FAVICON_BASE)}
        <span class="item__main">
          <span class="item__title">${escapeHtml(tab.title || tab.url)}${tab.pinned ? PIN_ICON : ''}</span>
          <span class="item__meta">${escapeHtml(host)}</span>
        </span>
        <span class="tree__actions">
          <button type="button" class="btn btn--ghost btn--sm"
                  data-switch-tab="${tab.tabId}" title="切换到这个标签页">打开</button>
        </span>
      </li>
    `
  }

  /**
   * 左栏现在的样子：结构 + 文本。
   *
   * **勾选不在签名里**：它由 `syncWindowStates()` 回填，把它算进签名反而会因为「勾一下」
   * 重建整列（而重建又会把勾选框恢复成未勾选）。
   */
  function windowSignatureOf(children: readonly WindowChild[]): string {
    return children
      .map((child) =>
        child.kind === 'tab'
          ? `t ${child.tab.tabId} ${child.tab.title} ${child.tab.url} ${child.tab.pinned ? 1 : 0}`
          : `g ${child.name} ${child.tabs
              .map((tab) => `${tab.tabId} ${tab.title} ${tab.url}`)
              .join('')}`
      )
      .join('')
  }

  function renderWindow(): void {
    // 结构没变就什么都不做。
    //
    // `refresh()` 会被频繁重跑（保存、删除、改名、拖一条收藏夹条目…），而它每次都要重建整个左栏：
    // 用户的屏幕上就是一次无意义的整列重绘（实测：挪一根分隔线时「存过去 (N)」闪一下）。
    // 凡是「由外部数据驱动、又会被频繁重跑」的渲染，都要先问一句：内容没变时能不能什么都不做。
    const signature = windowSignatureOf(windowChildren)
    if (signature === windowSignature) {
      syncWindowStates()
      return
    }
    windowSignature = signature
    windowCount.textContent = String(allWindowTabs().length)

    if (windowChildren.length === 0) {
      windowList.innerHTML = '<li class="empty">当前窗口没有可保存的标签页。</li>'
      updateButtons()
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
            </div>
            <ul class="kids">${child.tabs.map(tabRowMarkup).join('')}</ul>
          </li>
        `
      })
      .join('')

    syncWindowStates()
  }

  /** 让左栏的勾选框反映 `windowExcluded`。`innerHTML` 写不出 `checked`，必须手工回填。 */
  function syncWindowStates(): void {
    for (const input of windowList.querySelectorAll<HTMLInputElement>('[data-window-tab]')) {
      input.checked = !windowExcluded.has(Number(input.dataset.windowTab))
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
      tabs.filter((tab) => !windowExcluded.has(tab.tabId)).length,
      tabs.length
    )
    updateButtons()
  }

  // ———————————————— 右栏 ————————————————

  /**
   * 一条书签行。分隔线占位书签也画成一条横线，并且同样给「修改 / 删除」两个按钮。
   *
   * 两种行**都可以拖**（拖动范围与文件夹一致：在右栏里挪位置 / 挪层级，拖到左栏就是打开）：
   * 分隔线虽然只是个记号，但用户摆它的位置本来就有意义，所以它的拖拽逻辑与书签、文件夹完全一样。
   *
   * 分隔线没有勾选框（它不是书签，见 `isRealBookmark`），书签有——它是「要打开哪些」的一枚。
   *
   * 网址**完整显示**（不截成主机名）：收藏夹条目本来就靠网址区分同名页面，
   * 而小一号的字与一行的限制能把绝大多数网址完整装下。真的过长时仍会省略，
   * 那时 `title` 里还有完整的一份。
   */
  function archiveBookmarkRow(bookmark: BookmarkNode): string {
    const kind = separatorKind(bookmark.url)
    if (kind) {
      const isRenaming = renaming?.id === bookmark.id
      // 两种记号**外观完全不同**，因为它们在书签栏里的用途就不同：
      //   间隔（`?t=horz`，横向）画成一条通栏横线 —— 竖排列表里要一条横线才隔得开；
      //   分隔线（无参数，纵向）画成一枚竖线图标 —— 它是给书签栏那一排横排用的。
      // 名字与外观必须一起改（见 urls.ts）：光看「一条线」用户分不清自己在两个按钮里点了哪个。
      const label = SEPARATOR_LABELS[kind]
      const target = SEPARATOR_LABELS[toggledSeparatorKind(kind)]
      const rules = isRenaming || kind === 'sep'
        ? ''
        : '<span class="marker__rule" aria-hidden="true"></span>'
      // 两条横线用**真实元素**而不是伪元素：`::after` 永远排在所有子元素之后（这是规范定的），
      // 而按钮必须在这条线**右边**——用伪元素就只能得到「线在按钮右边」那种坏排布。
      return `
        <li class="marker marker--${kind}" draggable="true" data-drop-row="separator"
            data-drag-separator="${escapeHtml(bookmark.id)}">
          <span class="marker__slot" aria-hidden="true"></span>
          ${
            kind === 'sep' ? VERT_LINE_ICON : rules
          }
          ${
            isRenaming
              ? `<input type="text" class="input input--rename" draggable="false"
                        data-rename-input="${escapeHtml(bookmark.id)}"
                        value="${escapeHtml(separatorTitle(bookmark.title))}"
                        placeholder="${label}标题（可留空）" aria-label="${label}标题" />`
              : `<span class="marker__title">${escapeHtml(separatorTitle(bookmark.title))}</span>`
          }
          ${
            isRenaming || kind === 'sep' ? '' : rules
          }
          ${
            isRenaming
              ? ''
              : `<span class="tree__actions">
                   <button type="button" class="btn btn--ghost btn--sm"
                           data-swap-separator="${escapeHtml(bookmark.id)}"
                           title="改成${target}">转${target}</button>
                   <button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(bookmark.id)}">修改</button>
                   ${
                     pendingDeleteId === bookmark.id
                       ? `<button type="button" class="btn btn--danger btn--sm" data-confirm-delete="${escapeHtml(bookmark.id)}">确认删除</button>
                          <button type="button" class="btn btn--ghost btn--sm" data-cancel-delete="">取消</button>`
                       : `<button type="button" class="btn btn--ghost btn--sm" data-delete="${escapeHtml(bookmark.id)}">删除</button>`
                   }
                 </span>`
          }
        </li>
      `
    }

    const url = bookmark.url ?? ''
    const host = hostnameOf(url) ?? url

    return `
      <li class="item leaf" data-row data-drop-row="bookmark" draggable="true"
          data-drag-bookmark="${escapeHtml(bookmark.id)}"
          data-bookmark-url="${escapeHtml(url)}">
        <input type="checkbox" data-archive-item="${escapeHtml(bookmark.id)}" />
        ${faviconMarkup(url, FAVICON_BASE)}
        <span class="item__main">
          <span class="item__title">${escapeHtml(bookmark.title.trim() || host)}</span>
          <span class="item__meta item__meta--url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        </span>
        <span class="tree__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-open="${escapeHtml(bookmark.id)}">打开</button>
          <button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(bookmark.id)}">修改</button>
          ${
            pendingDeleteId === bookmark.id
              ? `<button type="button" class="btn btn--danger btn--sm" data-confirm-delete="${escapeHtml(bookmark.id)}">确认删除</button>
                 <button type="button" class="btn btn--ghost btn--sm" data-cancel-delete="">取消</button>`
              : `<button type="button" class="btn btn--ghost btn--sm" data-delete="${escapeHtml(bookmark.id)}">删除</button>`
          }
        </span>
      </li>
    `
  }

  /**
   * 一个子文件夹行。
   *
   * 它是**可以进去的一层**，不是可展开的分组：双击这一行（或点「进入」）把它变成当前展示的文件夹，
   * `↑ 上一层` 与面包屑负责往回走。这样层级再深也不会把面板撑成一根越来越长的缩进链。
   *
   * 勾选框仍然是「这一层里的书签全都要 / 全不要」的三态，与 `restoreFolder` 的口径一致
   * （它只处理一层：子文件夹建分组，散装书签不建分组）。所以**进不进去与勾不勾它是两件事**——
   * 勾上是「打开它里面的书签」，进去是「往它里面存东西 / 接着往下看」。
   */
  function archiveFolderRow(folder: BookmarkNode): string {
    // 计数只算真书签：分隔线不是书签，算进去会与文件管理器的直觉不符。
    const bookmarks = realBookmarks(folder.children ?? [])
    const isRenaming = renaming?.id === folder.id

    const title = isRenaming
      ? `<input type="text" class="input input--rename" draggable="false"
                data-rename-input="${escapeHtml(folder.id)}"
                value="${escapeHtml(folder.title)}" aria-label="重命名文件夹" />`
      : `<span class="item__title">${escapeHtml(folder.title)}</span>`

    const actions = isRenaming
      ? ''
      : `<span class="tree__actions">
           <button type="button" class="btn btn--ghost btn--sm" data-enter="${escapeHtml(folder.id)}">进入</button>
           <button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(folder.id)}">改名</button>
           ${
             pendingDeleteId === folder.id
               ? `<button type="button" class="btn btn--danger btn--sm" data-confirm-delete="${escapeHtml(folder.id)}">确认删除</button>
                  <button type="button" class="btn btn--ghost btn--sm" data-cancel-delete="">取消</button>`
               : `<button type="button" class="btn btn--ghost btn--sm" data-delete="${escapeHtml(folder.id)}">删除</button>`
           }
         </span>`

    return `
      <li class="group" data-row data-drop-row="folder" data-drop-folder="${escapeHtml(folder.id)}"
          data-enter-folder="${escapeHtml(folder.id)}">
        <div class="item group__head">
          <input type="checkbox" data-archive-item="${escapeHtml(folder.id)}" />
          <span class="folder-tile" aria-hidden="true">${FOLDER_ICON}</span>
          <span class="item__main item__main--row" draggable="true"
                data-drag-folder="${escapeHtml(folder.id)}" title="双击进入这一层">
            ${title}
            <span class="item__meta">${bookmarks.length} 个书签</span>
          </span>
          ${actions}
        </div>
      </li>
    `
  }

  /**
   * 能不能往当前这一层写。
   *
   * 书签树的根（路径长度为 1 的那个节点）只是三个内置目录的容器，Chrome 不接受在它下面直接建书签/文件夹，
   * 所以导航到那里时「存过去」、「新建文件夹」与「＋ 分隔线」都要禁用。
   * 它也是唯一一个没有父的节点，于是「路径只有一层」就是「是不是根」——
   * 不需要把 id `0` 这个魔法值写进业务代码。
   */
  function canWrite(): boolean {
    return viewPath.length > 1
  }

  /**
   * 面包屑。
   *
   * **除了当前层都能点**：当前层就是眼前这一页，做成链接只是噪声；其余每一层都能跳过去，
   * 包括默认展示文件夹**之上**的那几层——右栏是一个自由的浏览器，不是「只能往下走」的向导。
   * 用按钮而不是 `<a>`：它不换页，只换右栏的内容。
   *
   * 不可点的当前层也套一层 `.path__label`（与链接**同一个盒子**）：进了子文件夹后，
   * 原来那段文字会从「当前层」变成「可点的祖先」，盒子不同就会整排左右抽动一下。
   */
  function renderArchivePath(): void {
    // 面包屑也是**由外部数据驱动、又会被频繁重跑**的：`refresh()` 在一次动作里会跑好几遍，
    // 而它每次都会重写这几个按钮。重建的代价不只是浪费——那一排按钮会被换成新元素，
    // 悬停 / 焦点状态当场丢掉，用户看到的就是「字没变，但闪了一下」。
    // 所以与「内容没变就别重建 DOM」同一条规矩：签名没变就只更新下面那行说明。
    const signature = viewPath.map((node) => `${node.id}\u0000${node.title}`).join('\u0001')
    if (signature !== lastPathSignature) {
      lastPathSignature = signature
      archivePath.innerHTML = viewPath.length === 0
        ? '<span class="muted">还没落到任何一层</span>'
        : viewPath
            .map((node, index) => {
              const label = escapeHtml(node.title)
              if (index === viewPath.length - 1) {
                return `<span class="path__label" aria-current="location">${label}</span>`
              }
              return `<button type="button" class="path__link"
                              data-goto-folder="${escapeHtml(node.id)}">${label}</button>`
            })
            .join('<span class="path__sep">/</span>')
    }

    // 书签树的根上写入入口都是灰的，说清楚原因与退路，
    // 否则那个界面看起来就是「到了这里啥也干不了」。
    archiveNote.hidden = !viewFolderId || canWrite()
    archiveNote.textContent = '这里是书签树的根，Chrome 不允许直接在它下面存东西。双击下面任意一个文件夹进去即可。'
  }

  function renderArchive(): void {
    renderArchivePath()
    // 胸章数的是「这一层里能干活的东西」：子文件夹可以进去，书签可以打开。分隔线两样都不是。
    archiveCount.textContent = String(
      archiveChildren.filter((child) => !child.url).length + realBookmarks(archiveChildren).length
    )

    if (!viewFolderId) {
      archiveList.innerHTML =
        '<li class="empty">读不到书签栏，右栏无法显示内容。</li>'
      updateButtons()
      return
    }

    if (archiveChildren.length === 0) {
      archiveList.innerHTML = canWrite()
        ? '<li class="empty">这个文件夹还是空的。把左侧的标签拖过来即可存下。</li>'
        : '<li class="empty">这里是书签树的根，只能往下走。点下面的「书签栏」进去吧。</li>'
      updateButtons()
      return
    }

    archiveList.innerHTML = archiveChildren
      .map((child) => (child.url ? archiveBookmarkRow(child) : archiveFolderRow(child)))
      .join('')

    syncArchiveStates()
  }

  /** 右栏某个文件夹下的「会被打开」的书签 id。分隔线不在内：它没有勾选框，也不参与计数。 */
  function folderBookmarkIds(folder: BookmarkNode): string[] {
    return realBookmarks(folder.children ?? []).map((bookmark) => bookmark.id)
  }

  /**
   * 当前这一层里全部可打开的书签 id（含散装与分组内的）。
   *
   * **必须与 `restoreFolder` 的口径一致**：它跳过分隔线，所以这份名单也不能含分隔线。
   * 否则「打开（N）」会多算，而且全选框按这份名单算总数，一旦总数里混进了永远勾不上的项，
   * 它就会永远停在「部分选择」——点了全选也回不到「全不选」。
   */
  function archiveBookmarkIds(): string[] {
    return archiveChildren.flatMap((child) => {
      if (!child.url) return folderBookmarkIds(child)
      return isRealBookmark(child) ? [child.id] : []
    })
  }

  function archiveKeptCount(): number {
    return archiveBookmarkIds().filter((id) => !archiveExcluded.has(id)).length
  }

  function syncArchiveStates(): void {
    for (const input of archiveList.querySelectorAll<HTMLInputElement>('[data-archive-item]')) {
      const id = input.dataset.archiveItem
      if (!id) continue
      const folder = archiveChildren.find((child) => child.id === id && !child.url)
      if (!folder) {
        input.checked = !archiveExcluded.has(id)
        continue
      }
      const ids = folderBookmarkIds(folder)
      const kept = ids.filter((bookmarkId) => !archiveExcluded.has(bookmarkId)).length
      input.checked = kept > 0
      input.indeterminate = kept > 0 && kept < ids.length
    }

    const ids = archiveBookmarkIds()
    archiveSelectAll.update(ids.filter((id) => !archiveExcluded.has(id)).length, ids.length)
    updateButtons()
  }

  // ———————————————— 状态 ————————————————

  function updateButtons(): void {
    const keptTabs = allWindowTabs().filter((tab) => !windowExcluded.has(tab.tabId)).length
    const keptBookmarks = archiveKeptCount()

    saveLabel.textContent = countLabel('存过去', keptTabs)
    openLabel.textContent = countLabel('打开', keptBookmarks)
    openWindowLabel.textContent = countLabel('新窗口', keptBookmarks)
    // 落点写在按钮自己的提示里：写入目标是「当前展示的这一层」，而那一层远在右栏里侧的路径行里，
    // 中间的按钮与它隔了一整栏。悬停能确认「到底存进哪个文件夹」，不必来回对路径。
    saveButton.title = canWrite()
      ? `存进「${viewPath.at(-1)?.title ?? ''}」`
      : '书签树的根不接受写入，请先进入某个文件夹'
    saveButton.disabled = busy || keptTabs === 0 || !canWrite()
    openButton.disabled = busy || keptBookmarks === 0
    openWindowButton.disabled = busy || keptBookmarks === 0
    // 撤销按钮**始终占位**：没有可撤销的东西时只是藏起来（`visibility` 不进布局也不接键盘焦点），
    // 这样它出现 / 消失都不会把上面三个按钮上下推一下。
    undoButton.classList.toggle('is-slot-hidden', !lastWrite)
    undoButton.disabled = busy || !lastWrite
    newFolderButton.disabled = busy || !canWrite()
    newSeparatorButton.disabled = busy || !canWrite()
    newGapButton.disabled = busy || !canWrite()
    openRootButton.hidden = !viewFolderId
  }

  // ———————————————— 载入 ————————————————

  /**
   * 双击的两次 click 是两个独立事件，而第一次跳转会立刻重绘——第二次 click 打到的是**新的一层**，
   * 于是「双击进入」会变成「一下进去两层」。所以在跳转后短暂忽略新的跳转请求。
   * 人有意的两次点击间隔通常小于这个值，而真要连进两层就多点一次，代价很小。
   */
  const NAVIGATION_GUARD_MS = 350

  /** 跳到某一层（双击子文件夹、点「进入」、点面包屑、点「上一层」都走这里）。 */
  async function navigateTo(folderId: string): Promise<void> {
    if (busy || !folderId || folderId === viewFolderId) return
    const now = Date.now()
    if (now - lastNavigationAt < NAVIGATION_GUARD_MS) return
    lastNavigationAt = now

    // 换层时把行内编辑状态丢掉：那些控件已经不在眼前了。
    renaming = undefined
    pendingDeleteId = undefined
    viewFolderId = folderId
    await refresh()
  }

  async function refresh(): Promise<void> {
    favoriteFolderIds = (await loadSettings()).favoriteFolderIds
    windowChildren = planWindowChildren(await snapshotCurrentWindow())

    // 标签被关掉之后它的 tabId 不会再出现；留着只会让集合越涨越大。
    const aliveTabs = new Set(allWindowTabs().map((tab) => tab.tabId))
    for (const tabId of [...windowExcluded]) if (!aliveTabs.has(tabId)) windowExcluded.delete(tabId)

    // 视图落点：能留在原地就留在原地——用户在浏览收藏夹，不该因为一次刷新被弹回起点。
    // 只有当前层真的没了（被删掉 / 被挪到别处）才重新找一层。
    viewPath = viewFolderId ? await getNodePath(viewFolderId) : []
    if (viewPath.length === 0) await landOnStart()

    renderWindow()
    applyArchive(viewFolderId ? await getSubTree(viewFolderId) : undefined)
  }

  /** 只重读左栏。窗口里的标签变了（而收藏夹没动）时用它。 */
  async function refreshWindowOnly(): Promise<void> {
    windowChildren = planWindowChildren(await snapshotCurrentWindow())
    // 被关掉的标签不能继续留在排除集里，否则那个集合只会越涨越大。
    const alive = new Set(allWindowTabs().map((tab) => tab.tabId))
    for (const tabId of [...windowExcluded]) if (!alive.has(tabId)) windowExcluded.delete(tabId)
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
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // 只关心会改变这一行长相的字段；`status` / `favIconUrl` 变一次就重读一遍太多余。
    if (
      changeInfo.title !== undefined ||
      changeInfo.url !== undefined ||
      changeInfo.groupId !== undefined ||
      changeInfo.pinned !== undefined
    ) {
      scheduleWindowRefresh()
    }
  })

  /**
   * 重新决定右栏落在哪一层。
   *
   * 顺序是「第一个**可用**的收藏 → 书签栏自身 → 空」：
   * 收藏里可能已经删掉了几个，所以不能只看第一个；一个收藏都没有时落到书签栏——
   * 那是唯一一个“总是有意义”的层（它下面全是用户的文件夹，可以直接往下走）。
   * 书签栏都读不出来（数据异常）才真的空着，此时 `viewFolderId` 清空，让右栏去渲染空态。
   */
  async function landOnStart(): Promise<void> {
    for (const id of favoriteFolderIds) {
      const path = await getNodePath(id)
      if (path.length > 0) {
        viewFolderId = id
        viewPath = path
        return
      }
    }

    try {
      const barId = await getBookmarksBarId()
      viewFolderId = barId
      viewPath = await getNodePath(barId)
    } catch {
      // 连书签栏都读不出来时清空 id：否则下面会把它当成「有效但空的文件夹」去渲染。
      viewFolderId = ''
      viewPath = []
    }
  }

  /**
   * 右栏数据到齐后的公共部分：维护「见过的书签 id」并重渲染。
   *
   * 打开侧默认一个都不勾，靠这份「见过的」名单实现：没见过的书签一律算排除。
   * 余下的两个清理是把已经不在这一层的 id 丢掉，不然它们会越涨越大。
   */
  function applyArchive(folder: BookmarkNode | undefined): void {
    archiveChildren = folder?.children ?? []

    const alive = new Set(archiveBookmarkIds())
    for (const id of alive) {
      if (!knownBookmarks.has(id)) {
        knownBookmarks.add(id)
        archiveExcluded.add(id)
      }
    }
    for (const id of [...knownBookmarks]) if (!alive.has(id)) knownBookmarks.delete(id)
    for (const id of [...archiveExcluded]) if (!alive.has(id)) archiveExcluded.delete(id)

    renderArchive()
  }

  // ———————————————— 写入 / 撤销 / 打开 ————————————————

  async function writeInto(parentId: string, children: readonly WindowChild[]): Promise<void> {
    if (children.length === 0) return
    busy = true
    updateButtons()
    try {
      const result = await writeChildren(parentId, children)
      lastWrite = {folderIds: result.folderIds, bookmarkIds: result.bookmarkIds}
      const parts = [`已存下 ${result.saved} 个标签页`]
      if (result.groups > 0) parts.push(`${result.groups} 个分组`)
      setStatus(status, parts.join(' · '), 'ok')
      await events.archiveChanged()
      await refresh()
    } catch (error) {
      setStatus(status, `保存失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateButtons()
    }
  }

  /**
   * 撤销最近一次写入：先删新建的书签，再删新建的分组文件夹。
   *
   * 顺序不能反：删文件夹会连带删掉里面的书签，先删文件夹会让后面的书签 id 全部失效。
   */
  async function undo(): Promise<void> {
    if (busy || !lastWrite) return
    const target = lastWrite
    lastWrite = undefined
    busy = true
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
      busy = false
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
    if (busy || !viewFolderId) return
    busy = true
    updateButtons()
    setStatus(status, '正在打开…', 'ok')

    const options: RestoreOptions = {
      target: kind,
      groupTabs: !noGroupCheck.checked,
      excludeBookmarkIds: archiveExcluded
    }

    try {
      await restoreFolder(viewFolderId, options)
      setStatus(status, '', 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await events.archiveChanged()
    }
  }

  /** 把外部拖进来的网址存成书签（从网页里拖过来的链接走这条路）。 */
  async function saveUrls(urls: readonly string[], parentId: string): Promise<void> {
    if (urls.length === 0) return
    busy = true
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
      busy = false
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
    // 栏内是「移动」，跨栏是「复制一份」；两者都值得，所以 effectAllowed 给 copyMove。
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))

    // 有网址时也写一份 `text/uri-list`，这样拖到浏览器别处（书签栏、地址栏）也有意义。
    const url = dragged.dataset.bookmarkUrl
    if (url) event.dataTransfer.setData('text/uri-list', url)
    dragged.classList.add('is-dragging')
  })

  element.addEventListener('dragend', () => {
    dragging = undefined
    clearDropMarks()
  })

  /**
   * 行内落点：上缘 = 插到它前面，下缘 = 插到它后面，中间 = **进入**它。
   *
   * 「进入」只对能装东西的行成立（文件夹行、标签分组行）。三分法让一行的三个位置正好对应
   * 三种意图，不需要另加「拖到这里就进去」的按钮或悬停展开。
   */
  function spotIn(row: HTMLElement, clientY: number, canEnter: boolean): DropSpot {
    const rect = row.getBoundingClientRect()
    const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5
    if (!canEnter) return ratio < 0.5 ? 'before' : 'after'
    if (ratio < 0.3) return 'before'
    if (ratio > 0.7) return 'after'
    return 'into'
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
   * 右栏的落点：进某个文件夹，或插到当前这一层的某个位置。
   *
   * 三类行（文件夹 / 书签 / 分隔线）都是可锚定的——分隔线虽然只是个记号，
   * 但用户可以把它拖到任意两条之间，所以它不是特殊行。
   */
  function archiveDropSpot(event: DragEvent): ArchiveDrop | undefined {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>(
      '[data-drop-row="bookmark"], [data-drop-row="folder"], [data-drop-row="separator"]'
    )
    if (!row) return undefined

    const index = [...archiveList.children].indexOf(row)
    const isFolder = row.dataset.dropRow === 'folder'
    const spot = spotIn(row, event.clientY, isFolder)
    if (isFolder && spot === 'into') return {kind: 'into', folderId: row.dataset.dropFolder ?? ''}
    return {kind: 'here', index: spot === 'after' ? index + 1 : index}
  }

  /**
   * 「落在末尾」的提示：线画在**最后一行**的下缘，而不是把整栏高亮。
   *
   * 整栏高亮看起来像「丢进这一栏里，具体到哪儿我不知道」，而实际上写入总是**追加到末尾**，
   * 所以末尾那条线说的才是真话。只有列表真的是空的（没有任何行）才退化成整栏高亮。
   *
   * 行用 `querySelectorAll('[data-drop-row]')` 取全部（含分组内部的），文档顺序即视觉顺序；
   * 不能用 `:last-of-type`：那是按元素类型（`li`）算的，左栏最后一行的父级是 `.kids` 里的 `ul`，
   * 匹配不到就会掉到「整栏高亮」那条错路上去。
   */
  function markEndDrop(list: HTMLElement, pane: HTMLElement): void {
    const rows = list.querySelectorAll<HTMLElement>('[data-drop-row]')
    const last = rows[rows.length - 1]
    if (last) last.classList.add('is-drop-after')
    else pane.classList.add('is-drop-active')
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
    const externalUrls = Array.from(event.dataTransfer.types).includes('text/uri-list')
    if (!dragging && !externalUrls) return
    if (toArchive && !canWrite()) return

    const fromWindow = dragging?.kind === 'tab' || dragging?.kind === 'group'
    const fromArchive =
      dragging?.kind === 'bookmark' ||
      dragging?.kind === 'folder' ||
      dragging?.kind === 'separator'

    event.preventDefault()
    event.dataTransfer.dropEffect = toArchive && fromWindow ? 'copy' : 'move'
    clearDropMarks()

    if (toArchive && fromArchive) {
      // 挪一条收藏夹条目：与左栏同一套「行内三分法」。
      const spot = archiveDropSpot(event)
      const folderRow = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-row="folder"]')
      if (spot?.kind === 'into' && folderRow) {
        folderRow.classList.add('is-drop-active')
        return
      }
      if (spot?.kind === 'here') {
        const rows = [...archiveList.children]
        // 插到这一层末尾时，线画在最后一行的下缘。
        const anchor = rows[Math.min(spot.index, rows.length - 1)]
        if (anchor) {
          anchor.classList.add(spot.index >= rows.length ? 'is-drop-after' : 'is-drop-before')
          return
        }
      }
      // 落在行之间的空白处（或这一层是空的）：一律按「追加到末尾」提示。
      markEndDrop(archiveList, pane)
      return
    }

    if (toArchive) {
      // 存标签：落在文件夹行的中间就进那一层，否则进当前这一层（也就是追加到它的末尾）。
      const folderRow = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-row="folder"]')
      const inner = folderRow?.querySelector<HTMLElement>('.group__head') ?? folderRow
      const into = folderRow && inner && spotIn(inner, event.clientY, true) === 'into'
      if (into && folderRow) folderRow.classList.add('is-drop-active')
      else markEndDrop(archiveList, pane)
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
    const urls = event.dataTransfer
      .getData('text/uri-list')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))

    const toArchive = pane.dataset.dropPane === 'archive'
    // 落点在清掉标记之前算完：drop 的 target 与坐标都只在这一次事件里有效。
    const archiveSpot = toArchive ? archiveDropSpot(event) : undefined
    const windowSpot = toArchive ? undefined : windowDropSpot(event)

    dragging = undefined
    clearDropMarks()

    if (toArchive) {
      if (!canWrite()) return
      if (payload?.kind === 'bookmark' || payload?.kind === 'folder' || payload?.kind === 'separator') {
        // 收藏夹里的条目拖回收藏夹 = **挪**（同一个东西换位置），不是再存一份。
        await moveArchiveNode(payload, archiveSpot)
        return
      }
      const parentId =
        archiveSpot?.kind === 'into' ? archiveSpot.folderId : viewFolderId
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
      await openArchiveInto(payload, windowSpot ?? {kind: 'end'})
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
    if (busy) return
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

    busy = true
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
      busy = false
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
   * 把收藏夹里的一条书签或文件夹挪到落点。
   *
   * `bookmarks.move` 的 index 与 `tabs.move` **相反**：传的是**移动前**坐标系里的插入位置
   * （`BookmarkModel::Move` 里有 `if (old_parent == new_parent && index > old_index) index--`，
   * 同父下移由 Chrome 自己减），所以插到锚点前就传锚点的下标、插到锚点后就传下标 + 1。
   *
   * 右栏一次只显示一层，所以落点的锚点永远是兄弟——不存在「把文件夹拖进它自己的子孙」这种事。
   */
  async function moveArchiveNode(
    payload: {kind: 'bookmark' | 'folder' | 'separator'; id: string},
    spot: ArchiveDrop | undefined
  ): Promise<void> {
    if (busy || !canWrite()) return
    if (spot?.kind === 'into' && spot.folderId === payload.id) return

    // **不置灰按钮**：`busy` 只是防重入（上面的守卫），而这一步几乎是瞬时的。
    // 一旦在这里调 `updateButtons()`，中间那排按钮会先变灰再恢复——用户看到的就是「按钮闪一下」。
    // 真会花时间的操作（保存一整窗、打开几十个标签）才该置灰，见 `writeInto` / `openSelection`。
    busy = true
    try {
      if (spot?.kind === 'into') {
        // 不给 index：`bookmarks.move` 省略 index 就是追加到末尾。
        await chrome.bookmarks.move(payload.id, {parentId: spot.folderId})
      } else {
        await chrome.bookmarks.move(payload.id, {
          parentId: viewFolderId,
          index: spot?.kind === 'here' ? spot.index : archiveChildren.length
        })
      }
      setStatus(status, '已调整收藏夹顺序。', 'ok')
    } catch (error) {
      setStatus(status, `调整失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await events.archiveChanged()
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
  async function openArchiveInto(payload: DragPayload, drop: WindowDrop): Promise<void> {
    if (busy) return
    const items = archiveOpenItems(payload)
    if (items.length === 0) {
      setStatus(status, '这一条里没有可以打开的网址。', 'error')
      return
    }

    const count = allWindowTabs().length
    const startAt = drop.kind === 'end' ? count : drop.after ? drop.anchorIndex + 1 : drop.anchorIndex

    busy = true
    updateButtons()
    setStatus(status, '正在打开…', 'ok')
    try {
      const tabIds: number[] = []
      for (const [offset, item] of items.entries()) {
        const tab = await chrome.tabs.create({url: item.url, index: startAt + offset, active: false})
        if (tab.id !== undefined) tabIds.push(tab.id)
      }

      // 文件夹开的标签收进一个同名分组；单条书签就让它当散装标签。
      const groupTitle = payload.kind === 'folder' ? (archiveFolderTitle(payload.id) ?? '') : ''
      if (groupTitle && tabIds.length > 0) {
        const groupId = await chrome.tabs.group({tabIds: tabIdArg(tabIds)})
        await chrome.tabGroups.update(groupId, {title: groupTitle})
      }

      await discardCommittedTabs(tabIds, {keepLoadedTabId: tabIds[0]})
      setStatus(status, `已打开 ${tabIds.length} 个标签页。`, 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await refresh()
    }
  }

  /** 要开成标签的那几条（书签就是它自己；文件夹取它直属的真书签，内部页面跳过）。 */
  function archiveOpenItems(payload: DragPayload): {url: string}[] {
    if (payload.kind === 'bookmark') {
      const url = bookmarkUrl(payload.id)
      return url && !isInternalUrl(url) ? [{url}] : []
    }
    if (payload.kind !== 'folder') return []

    const folder = archiveChildren.find((child) => child.id === payload.id)
    return realBookmarks(folder?.children ?? [])
      .map((node) => node.url as string)
      .filter((url) => !isInternalUrl(url))
      .map((url) => ({url}))
  }

  function archiveFolderTitle(id: string): string | undefined {
    return archiveChildren.find((child) => child.id === id)?.title
  }

  function bookmarkUrl(id: string): string | undefined {
    for (const child of archiveChildren) {
      if (child.id === id && child.url) return child.url
      const hit = (child.children ?? []).find((node) => node.id === id)
      if (hit?.url) return hit.url
    }
    return undefined
  }

  // ———————————————— 勾选 ————————————————

  /**
   * 点整行 = 点它的勾选框。
   *
   * 实现上是**替用户点那个复选框**，而不是另写一份勾选逻辑：三态（分组行与文件夹行）的
   * 「全选 ↔ 全不选」意图判定只在 `change` 处理器里写了一次，再写一份必然分叉。
   *
   * 勾选框、行内按钮、重命名输入框各有自己的语义，落在它们身上不算「点行」。
   */
  function toggleRowFromClick(list: HTMLElement, event: MouseEvent): void {
    const target = event.target as HTMLElement
    if (target.closest('input, button, a')) return
    const row = target.closest<HTMLElement>('[data-row]')
    if (!row || !list.contains(row)) return
    row.querySelector<HTMLInputElement>('input[type=checkbox]')?.click()
  }

  windowList.addEventListener('click', (event) => {
    const switchButton = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-switch-tab]'
    )
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

  element.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement

    const tabId = input.dataset.windowTab
    if (tabId !== undefined) {
      if (input.checked) windowExcluded.delete(Number(tabId))
      else windowExcluded.add(Number(tabId))
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
          if (wantAll) windowExcluded.delete(tab.tabId)
          else windowExcluded.add(tab.tabId)
        }
      }
      syncWindowStates()
      return
    }

    const itemId = input.dataset.archiveItem
    if (itemId !== undefined) {
      const folder = archiveChildren.find((child) => child.id === itemId && !child.url)
      if (folder) {
        const ids = folderBookmarkIds(folder)
        const kept = ids.filter((id) => !archiveExcluded.has(id)).length
        const wantAll = nextSelectAll(triState(kept, ids.length))
        for (const id of ids) {
          if (wantAll) archiveExcluded.delete(id)
          else archiveExcluded.add(id)
        }
      } else if (input.checked) {
        archiveExcluded.delete(itemId)
      } else {
        archiveExcluded.add(itemId)
      }
      syncArchiveStates()
    }
  })

  // ———————————————— 行内操作 ————————————————

  archiveList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const confirmButton = target.closest<HTMLButtonElement>('[data-confirm-delete]')
    if (confirmButton?.dataset.confirmDelete) {
      void confirmDelete(confirmButton.dataset.confirmDelete)
      return
    }
    const deleteButton = target.closest<HTMLButtonElement>('[data-delete]')
    if (deleteButton?.dataset.delete) {
      pendingDeleteId = deleteButton.dataset.delete
      renderArchive()
      return
    }
    if (target.closest('[data-cancel-delete]')) {
      pendingDeleteId = undefined
      renderArchive()
      return
    }
    const renameButton = target.closest<HTMLButtonElement>('[data-rename]')
    if (renameButton?.dataset.rename) {
      const id = renameButton.dataset.rename
      pendingDeleteId = undefined
      // 书签有标题**与网址**两个字段可改，行内一个输入框放不下两个，所以走模态弹窗；
      // 文件夹与分隔线只有标题，行内改名更快（建完就能直接打字）。
      if (realBookmarkId(id)) editBookmark(id)
      else {
        renaming = {id, committed: false}
        renderArchive()
        focusRenameInput()
      }
      return
    }

    const enterButton = target.closest<HTMLButtonElement>('[data-enter]')
    if (enterButton?.dataset.enter) {
      void navigateTo(enterButton.dataset.enter)
      return
    }

    const swapButton = target.closest<HTMLButtonElement>('[data-swap-separator]')
    if (swapButton?.dataset.swapSeparator) {
      void swapSeparator(swapButton.dataset.swapSeparator)
      return
    }

    const openButton = target.closest<HTMLButtonElement>('[data-open]')
    if (openButton?.dataset.open) {
      void openBookmarkNow(openButton.dataset.open)
      return
    }

    // 剩下的情况就是「点在行上」：切换这一行的勾选。按钮与输入框在上面已经拦住了。
    toggleRowFromClick(archiveList, event)
  })

  /**
   * 这一条是不是真书签（不是文件夹也不是分隔线）——只有它才需要弹窗改网址。
   *
   * 不能只看「有没有 url」：分隔线也带 url，而它的网址是那个占位记号，
   * 给用户一个能改它的输入框只会把记号改坏。
   */
  function realBookmarkId(id: string): boolean {
    return archiveChildren.some((child) => child.id === id && isRealBookmark(child))
  }

  /** 弹窗改一条书签的标题与网址。取消时什么都不做。 */
  function editBookmark(id: string): void {
    const node = archiveChildren.find((child) => child.id === id)
    if (!node) return
    openBookmarkDialog(
      element,
      {title: node.title, url: node.url ?? ''},
      async ({title, url}) => {
        // 标题允许留空（Chrome 会退回去显示网址），与新建分隔线时一样。
        await updateNode(id, {title: sanitizeFolderName(title, ''), url})
        await events.archiveChanged()
      }
    )
  }

  /**
   * 点「打开」把这一条开成一枚活动标签。
   *
   * 与拖到窗口里不同：拖过去是「把它放进这一批里」，所以不抢焦点（`active: false`）；
   * 而点「打开」就是「我现在要看它」，所以让它成为当前标签。
   *
   * 内部页面（`chrome://` 等）先挡掉：Chrome 不允许扩展打开它们，
   * 不挡的话用户看到的是 API 抛出的原始错误（实测 `chrome://discards/` 这类书签在收藏夹里是存在的）。
   */
  async function openBookmarkNow(id: string): Promise<void> {
    const url = bookmarkUrl(id)
    if (!url) return
    if (isInternalUrl(url)) {
      setStatus(status, '这是浏览器内部页面，扩展打不开它，请手动复制网址。', 'error')
      return
    }
    try {
      await chrome.tabs.create({url, active: true})
      setStatus(status, '已打开。', 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    }
  }

  /**
   * 双击进入下一层。
   *
   * 勾选框与行内按钮有自己的语义，落在它们身上不算「进入」——否则双击「删除」会顺手进去一层。
   */
  archiveList.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('input, button, [data-rename-input]')) return
    const row = target.closest<HTMLElement>('[data-enter-folder]')
    if (row?.dataset.enterFolder) void navigateTo(row.dataset.enterFolder)
  })

  archivePath.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-goto-folder]')
    if (link?.dataset.gotoFolder) void navigateTo(link.dataset.gotoFolder)
  })

  archiveList.addEventListener('keydown', (event) => {
    const input = event.target as HTMLInputElement
    const id = input.dataset.renameInput
    if (id === undefined) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitRename(input, id)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      renaming = undefined
      renderArchive()
    }
  })

  // 点开别处也算确认——不然改了名字却留在编辑框里，看着像没保存。
  archiveList.addEventListener(
    'focusout',
    (event) => {
      const input = event.target as HTMLInputElement
      if (input.dataset.renameInput !== undefined) {
        void commitRename(input, input.dataset.renameInput)
      }
    },
    true
  )

  async function commitRename(input: HTMLInputElement, id: string): Promise<void> {
    if (!renaming || renaming.id !== id || renaming.committed) return
    renaming.committed = true
    const node = archiveChildren.find((child) => child.id === id)
    if (!node) return

    // 只服务文件夹与分隔线（书签的改名走模态弹窗，见 editBookmark）。
    // 文件夹名不能为空，所以清洗后退回原名字；分隔线允许留空（就成了一条通线）。
    const fallback = isSeparatorUrl(node.url) ? '' : node.title
    const next = sanitizeFolderName(input.value, fallback)
    try {
      if (next !== node.title) await updateNode(id, {title: next})
    } catch (error) {
      setStatus(status, `改名失败：${errorText(error)}`, 'error')
    } finally {
      renaming = undefined
      await events.archiveChanged()
    }
  }

  async function confirmDelete(id: string): Promise<void> {
    if (busy) return
    // 只立 `busy`（防重入）而**不置灰按钮**：删一条几乎是瞬时的，而「置灰 → 恢复」
    // 会让一整排按钮闪一下（与 moveArchiveNode 同一个理由）。
    busy = true
    pendingDeleteId = undefined
    try {
      await removeSubTree(id)
      // 删的是当前层里的子项，所以视图本身不用动——删掉之后再刷新自然少一行。
      setStatus(status, '已删除。', 'ok')
    } catch (error) {
      setStatus(status, `删除失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await events.archiveChanged()
    }
  }

  // ———————————————— 按钮 ————————————————

  // 「存过去」写的是**当前展示的这一层**，不是某个固定的起点：右栏是一个可导航的浏览器，
  // 「站在哪儿就往哪儿存」才说得通。书签树的根不接受写入，用 canWrite 挡住。
  saveButton.addEventListener('click', () => {
    if (canWrite()) void writeInto(viewFolderId, keptWindowChildren())
  })

  // 两个打开入口按「这一次要开到哪里」分：当前窗口 / 新窗口。
  // 「建不建分组」是另一个维度，由上面那个复选框说了算（见 openSelection）。
  // 它们与拖拽共用 restoreFolder，口径不会分叉。
  openButton.addEventListener('click', () => void openSelection('currentWindow'))
  openWindowButton.addEventListener('click', () => void openSelection('newWindow'))
  undoButton.addEventListener('click', () => void undo())

  // 「打开书签管理器」要的是当前展示的这一层，但给不出能定位的 id：
  //
  // 管理器只认它自己的 UUID，而 `chrome.bookmarks` 给的是数字 id（`?id=` 上的旧数字 id 兜底
  // 实测不生效）。所以我们只能**按标题搜**，把那一层摆到搜索结果里让用户点一下。
  // 状态行要如实写出这一点——它毕竟不是「直接跳进那一层」。
  openRootButton.addEventListener('click', async () => {
    if (!viewFolderId) return
    // 书签树的根没有自己的标题（`getNodePath` 给它的兜底是「书签」），拿它去搜没有意义，
    // 那一层就直接开管理器的默认页。
    const title = canWrite() ? (viewPath.at(-1)?.title ?? '') : ''
    try {
      await openInBookmarkManager(title)
      setStatus(
        status,
        title
          ? `书签管理器已打开，已按「${title}」搜索——扩展拿不到管理器要的 UUID，不能直接跳进去。`
          : '书签管理器已打开。',
        'ok'
      )
    } catch (error) {
      // 这里的错误文案是写给用户看的（含快捷键），不是 API 的原文，所以直接展示。
      setStatus(status, errorText(error), 'error')
    }
  })

  newFolderButton.addEventListener('click', async () => {
    if (!canWrite() || busy) return
    busy = true
    updateButtons()
    try {
      const name = await nextFolderName(viewFolderId)
      const created = await createFolder(viewFolderId, name)
      // 建完直接进入改名状态：空文件夹只有名字可改，先让用户把名字定下来。
      renaming = {id: created.id, committed: false}
      await events.archiveChanged()
      await refresh()
      focusRenameInput()
    } catch (error) {
      setStatus(status, `新建失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateButtons()
    }
  })

  // 两种记号各一个按钮，**不合并成一个再让用户去改**：它们外观完全不同，
  // 建完再转一次是多余的一步（而且刚建的那一枚还分不清是哪种）。
  // 建完直接进入改名状态：它的全部意义常常就在那个标题上。
  async function createMarker(kind: SeparatorKind): Promise<void> {
    if (!canWrite() || busy) return
    busy = true
    updateButtons()
    try {
      const created = await createBookmark(viewFolderId, '', separatorUrlOf(kind))
      lastWrite = {folderIds: [], bookmarkIds: [created.id]}
      renaming = {id: created.id, committed: false}
      await events.archiveChanged()
      await refresh()
      focusRenameInput()
    } catch (error) {
      setStatus(status, `新建失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateButtons()
    }
  }

  newSeparatorButton.addEventListener('click', () => void createMarker('sep'))
  newGapButton.addEventListener('click', () => void createMarker('gap'))

  /**
   * 把一枚记号在两种形态之间转换（分隔线 ⇄ 间隔）。
   *
   * 只改 `url`：两种记号的差别就在那个 `?t=horz`，而标题是用户自己写的，
   * 与它是横线还是竖线无关——顺手把标题也改掉会丢掉用户写的东西。
   */
  async function swapSeparator(id: string): Promise<void> {
    if (busy) return
    const kind = separatorKind(archiveChildren.find((child) => child.id === id)?.url)
    if (!kind) return
    const next = toggledSeparatorKind(kind)

    busy = true
    pendingDeleteId = undefined
    try {
      await updateNode(id, {url: separatorUrlOf(next)})
      setStatus(status, `已改成${SEPARATOR_LABELS[next]}。`, 'ok')
    } catch (error) {
      setStatus(status, `转换失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await events.archiveChanged()
    }
  }

  /**
   * 把光标放到刚出现的重命名输入框的**最前面**。
   *
   * `focus()` 只给焦点，插入点会落在内容末尾；而新建出来的默认名是时间戳，
   * 用户十有八九要在前面加自己的名字——放到开头，直接打字就是「我的名字 + 时间戳」。
   */
  function focusRenameInput(): void {
    const input = archiveList.querySelector<HTMLInputElement>('[data-rename-input]')
    if (!input) return
    input.focus()
    // 有些浏览器在 focus 时会全选内容，所以显式把选区收成开头处的空选区。
    input.setSelectionRange(0, 0)
  }

  /**
   * 新建文件夹的默认名：本地时间（`2026-10-02 23:51`）。
   *
   * 这里**只**避开同一层里完全相同的默认名（同一分钟内连建两个才会撞上），不是去重机制：
   * 用户自己打的重名一律放行，见 docs/design.md。
   */
  async function nextFolderName(parentId: string): Promise<string> {
    const base = formatTimestamp(new Date())
    const {children} = await getSubtreeChildren(parentId)
    const taken = new Set(children.map((child) => child.title))
    if (!taken.has(base)) return base
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base} ${n}`
      if (!taken.has(candidate)) return candidate
    }
    return `${base} ${Date.now()}`
  }

  async function getSubtreeChildren(
    parentId: string
  ): Promise<{children: BookmarkNode[]}> {
    const node = await getSubTree(parentId)
    return {children: node?.children ?? []}
  }

  return {element, refresh, navigateTo, currentFolderId: () => viewFolderId}
}
