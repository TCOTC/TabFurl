/*
 * 收藏夹面板的一个实例。
 *
 * 右栏原本就是这一套，F7 之后**左栏也能切成收藏夹**，于是它必须能被实例化两次。
 * 复制一份是行不通的：两份实现一定会分叉，而分叉的表现正是这个项目反复要避免的那类错觉
 * （列表看着全选、按钮说没选中）。所以整套搬进一个工厂，两栏各持一个实例。
 *
 * 面板只提供**位置**与几个回调（见 `ArchivePaneDeps`），不参与这里的状态：
 * 「我站在哪一层、展开了哪些、勾掉了哪些」都是本实例自己的。
 *
 * 三条历史结论随代码一起搬了过来，不要因为「看着像优化」而改掉：
 * 虚拟滚动（真实数据全部展开是 11004 行，必须只渲染视口那几十行）、
 * 行高从真实元素上量（CSS 变量一改，写死的行高会静默错位）、
 * 签名用 `JSON.stringify` 拼（手写分隔符隐含「内容里不会有这个字符」这个错前提）。
 */
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
import {formatTimestamp, sanitizeFolderName} from '../shared/naming'
import {openInBookmarkManager} from '../shared/restore'
import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {BookmarkNode} from '../shared/types'
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
  createSelectAll,
  errorText,
  nextSelectAll,
  q,
  setStatus,
  spotIn,
  toggleRowFromClick,
  triState,
  type AppEvents,
  type ArchiveDrop,
  type DragPayload
} from './dom'
import {openBookmarkDialog} from './BookmarkDialog'
import {CHEVRON_ICON, FAVICON_BASE, FOLDER_ICON, VERT_LINE_ICON} from './icons'

/** 面板递给实例的那几样东西。 */
export interface ArchivePaneDeps {
  /** 面板的根元素：本实例的元素都从它里面取（模板由面板给出）。 */
  root: HTMLElement
  /**
   * 本实例那几个元素的 id 前缀（`archive` / `left-archive`）。
   *
   * 两栏各有一个实例、又住在同一份 DOM 里，元素 id 重了就会各自找到对方的东西
   * （`q()` 只查第一个匹配），而那种错很安静：一边勾选、另一边变。
   */
  idPrefix: string
  /** 跨模块通知（改了书签树之后要让别处刷新）。 */
  events: AppEvents
  /**
   * 共享的忙标记。
   *
   * 两栏各有一个实例，但「正在写入」这件事是全局的：保存到一半不该能删书签。
   * 所以**不各记一份**，而是共用同一个对象（面板持有它，两栏都读写同一个字段）。
   */
  flags: {busy: boolean}
  /** 底部那一行状态文字。 */
  status: HTMLElement
  /** 撤销目标：面板记着最近一次写入新建的 id，所以这里只负责告诉它。 */
  rememberWrite(result: {folderIds: string[]; bookmarkIds: string[]}): void
  /** 「打开界面时落在哪一层」的候选（面板刚读到的收藏列表）。 */
  favoriteIds(): readonly string[]
  /**
   * 这一栏的「会影响面板」的状态变了（换了层、或勾选变了）——叫一声。
   *
   * 面板中间那一列是跟着本栏走的：「存进『这一层』」那句提示、书签树根上不许写入，
   * 还有「打开 (N)」那个计数。不叫这一声，勾了一条之后按钮还写着 (0)——
   * 看着就像「勾了没反应」。
   *
   * 注意只在本栏自己的变化处叫，**不要放进 `syncArchiveStates()`**：
   * 那个函数在每次重绘窗口时都会跑（滚动时每帧一次），放进去就会让中间那一列
   * 在滚动期间每帧被重算一遍。
   */
  onStateChanged(): void
}

/** 面板能从这个实例上问到、或让它做的事。 */
export interface ArchivePane {
  /** 列表（`ul.list`）。拖拽落点的判断以它为准。 */
  readonly list: HTMLUListElement
  /** 全选框那一行的容器——面板往里面塞「刷新」按钮（两栏位置对称由面板统一保证）。 */
  readonly actionsHost: HTMLElement
  /** 「在书签管理器里打开这一层」那枚按钮，由面板与刷新按钮一起排进上面那一行。 */
  readonly openRootButton: HTMLButtonElement
  /** 这一层能不能写入（书签树的根不能）。 */
  isWritable(): boolean
  /** 当前站在哪一层（空串 = 还没落到任何一层）。 */
  currentFolderId(): string
  /** 当前这一层的名字（面包屑最后那一段），写进「存过去」的悬停提示里。 */
  currentFolderTitle(): string
  /** 这一层里「还会被打开」的书签枚数。 */
  keptCount(): number
  /**
   * 这一栏要不要显示勾选框。
   *
   * 窗口档下右栏要（勾选驱动「存过去 / 打开 (N)」）；而**两栏都是收藏夹时两栏都不要**：
   * 那一档完全靠拖拽（拖哪一行就搬哪一行），勾选框在那里只会让人以为
   * 「先勾上、再点中间的按钮」——而中间那一列在那个档下整个不在了。
   */
  setSelectable(enabled: boolean): void
  /** 被勾掉的书签 id（打开侧默认全不勾）。 */
  excluded(): ReadonlySet<string>
  /** 重新读自己这一层并重绘。 */
  reload(): Promise<void>
  /** 跳到某一层。 */
  navigateTo(folderId: string): Promise<void>
  /** 刷新那几个按钮的可用状态。 */
  updateButtons(): void
  /** 勾选框变了；返回 true 表示这个输入框属于本实例。 */
  handleChange(input: HTMLInputElement): boolean
  /** 拖拽落点。 */
  dropSpot(event: DragEvent): ArchiveDrop | undefined
  /** 这个落点收不收这份载荷。 */
  canDropAt(payload: DragPayload, targetId: string): boolean
  /** 落点对应的「收件层」。 */
  dropTargetId(spot: ArchiveDrop): string
  /** 把本栏的一条书签 / 文件夹 / 记号挪到落点。 */
  moveNode(
    payload: {kind: 'bookmark' | 'folder' | 'separator'; id: string},
    spot: ArchiveDrop | undefined
  ): Promise<void>
  /** 要开成标签的那几条（拖到窗口里时用）。 */
  openItems(payload: DragPayload): {url: string}[]
  /** 某个文件夹的标题（拖到窗口里时给新分组起名）。 */
  folderTitle(id: string): string | undefined
  /** 下一次重读时展开这些文件夹（刚存下的分组），并把其中第一个滚进视野。 */
  expandOnNextReload(ids: readonly string[], scrollId?: string): void
}

export function createArchivePane(deps: ArchivePaneDeps): ArchivePane {
  const {root, events, flags, status} = deps
  /** 本实例的元素 id 都带这个前缀（见 `ArchivePaneDeps.idPrefix`）。 */
  const id = (suffix: string): string => `#${deps.idPrefix}-${suffix}`

  const archiveList = q<HTMLUListElement>(root, id('list'))
  /**
   * 本栏的滚动容器（`.box`，不是那个 `ul`）。
   *
   * 虚拟滚动要读它的 `scrollTop` / `clientHeight`，并且只监听它的滚动——
   * 设计上整页只有一条滚动条，滚动交给两栏各自的 `.box`，`ul` 自己不滚动。
   */
  const archiveBox = archiveList.closest<HTMLElement>('.box') ?? archiveList

  const archiveCount = q<HTMLSpanElement>(root, id('count'))
  const archivePath = q<HTMLElement>(root, id('path'))
  const archiveNote = q<HTMLParagraphElement>(root, id('note'))

  const expandAllButton = q<HTMLButtonElement>(root, id('expand-all-btn'))
  const newFolderButton = q<HTMLButtonElement>(root, id('new-folder-btn'))
  const newSeparatorButton = q<HTMLButtonElement>(root, id('new-separator-btn'))
  const newGapButton = q<HTMLButtonElement>(root, id('new-gap-btn'))
  const openRootButton = q<HTMLButtonElement>(root, id('open-root-btn'))

  const archiveSelectAll = createSelectAll(q<HTMLDivElement>(root, id('all-host')), {
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
      deps.onStateChanged()
    }
  })

  /**
   * 右栏当前展示的哪一层。
   *
   * 右栏不是一棵可展开的树，而是一个**可导航的浏览器**：双击子文件夹行进去，`↑ 上一层` 退回来，
   * 面包屑可以跳到路径上的任意一层。理由见 `docs/design.md`：层级一深，缩进链会把面板压成一条细缝，
   * 而「上一层」是 O(1) 的退路，缩进不是。
   */
  let viewFolderId = ''

  /**
   * 当前展示的文件夹从树根到自身的完整路径（含自身），用于面包屑与「上一层」。
   *
   * 与 `expandedIds` 是**两件事**：这里是「我站在哪一层」，那里是「一眼多看了几层」。
   *  Finder 的列表视图也是两者并存（清单里可以推开子文件夹，同时自己在某一层）。
   */
  let viewPath: {id: string; title: string}[] = []
  /**
   * 面包屑上一次渲染用的签名。
   *
   * 初值是 `undefined` 而不是空串：`viewPath` 为空时签名也是空串，一撞就会把「第一次
   * 该画那句『还没落到任何一层』」当成「内容没变」跳过。
   */
  let lastPathSignature: string | undefined

  let archiveChildren: BookmarkNode[] = []
  /** 当前展开状态下**可见的行**，扁平成一个数组（虚拟滚动以它为单位，见 `flattenArchive`）。 */
  let archiveRows: ArchiveRow[] = []

  /**
   * 已经在一行行里展开的文件夹 id（Finder 那样就地推开，与「进入」是两件事）。
   *
   * **不落盘**：它是一次浏览过程中的临时视图状态，不是偏好。换一层（`navigateTo`）会清空。
   */
  const expandedIds = new Set<string>()

  /**
   * 下一次刷新时要展开的文件夹（刚存下的分组）。
   *
   * 为什么不在 `writeInto` 里当场展开：新节点的 `parentById` 要等 `applyArchive`
   * 重新读完树、重建索引之后才知道，而祖先链得靠它。所以这里只记下 id，
   * 到索引完备的那一趟再展开（见 `applyArchive`）。
   */
  let pendingExpandIds: string[] = []
  /** 下一次刷新后要滚进视野的那一行。新建的东西会落在末尾，不滚过去就看不见。 */
  let pendingScrollId: string | undefined

  /**
   * 已载入节点的索引：当前层 + 它下面**所有后代**。
   *
   * 为什么可以先建一张全量索引：`getSubTree()` 本来就把整棵子树递归读进来了，
   * 所以「展开某一层」不需要再去读一次——它要的那些节点已经在手上（展开是纯渲染状态，零 IPC）。
   *
   * 为什么必须有这张索引：展开之后行不再只属于当前层，而下面这些动作都只认识 id——
   * 改名、删除、打开、转换记号、弹窗改书签、勾选框三态的回填。以前它们都在
   * `archiveChildren` 里找，那种写法在有了后代之后就找不到了。
   */
  let nodeIndex = new Map<string, BookmarkNode>()
  /** id → 父 id。删掉一个节点后把它的展开状态收掉、不让把文件夹拖进自己的子孙里，都靠它。 */
  let parentById = new Map<string, string>()

  /** 右栏被勾掉的书签 id（打开侧默认全不勾，所以记排除 + 一份「见过的」）。 */
  const archiveExcluded = new Set<string>()
  const knownBookmarks = new Set<string>()
  let pendingDeleteId: string | undefined

  let renaming: {id: string; committed: boolean} | undefined

  /** 上一次跳转的时刻，用于吞掉双击带来的第二次跳转（见 `navigateTo`）。 */
  let lastNavigationAt = 0

  // ———————————————— 右栏 ————————————————

  /**
   * 扁平化之后的一行。**虚拟滚动以行为单位，行与行之间没有嵌套**——层级靠 `depth` 算出的缩进表达。
   *
   * 为什么要扁平（这里是实测，不是估计）：真实数据下「全部展开」是 **11003 行**，
   * 一次性拼进 `innerHTML` 会产出 **11.5 万个元素 / 12 MB 字符串**，
   * 同步部分卡 **983 ms**、随后布局又花 **2402 ms**。
   * 扁平之后可以只渲染视口里那几十行，把这两项都变成常数级。
   */
  type ArchiveNodeRow = {
    kind: 'node'
    node: BookmarkNode
    parentId: string
    depth: number
    /** 在**同一层**里的下标。拖拽算插入位置用它，不必再去 DOM 里数兄弟。 */
    siblingIndex: number
    /** 只有文件夹行有意义。 */
    expanded: boolean
  }
  type ArchiveRow = ArchiveNodeRow | {kind: 'empty'; depth: number}

  /**
   * 当前展开状态下的**可见行**，扁平成一个数组。
   *
   * 只走一遍树、只产出数据，不碰 DOM：所以「全部展开」这一步本身是纯内存操作
   * （实测真实数据 11003 行约 20 ms），贵的那部分留给了窗口渲染。
   */
  function flattenArchive(): ArchiveRow[] {
    const rows: ArchiveRow[] = []
    const walk = (nodes: readonly BookmarkNode[], parentId: string, depth: number): void => {
      nodes.forEach((node, siblingIndex) => {
        const expanded = !node.url && expandedIds.has(node.id)
        rows.push({kind: 'node', node, parentId, depth, siblingIndex, expanded})
        if (!expanded) return
        const children = node.children ?? []
        // 空文件夹展开后要有一行交代，否则点开之后什么都没有，看着像「点了没反应」。
        if (children.length === 0) rows.push({kind: 'empty', depth: depth + 1})
        else walk(children, node.id, depth + 1)
      })
    }
    walk(archiveChildren, viewFolderId, 0)
    return rows
  }

  /** 视口上下各多渲染几行，滚动时不会看到正在补的空行。 */
  const ARCHIVE_OVERSCAN = 10

  /**
   * 行高。**从真实元素上量**，不写死 38px——那个数由 `--row-inner` 与 `--item-pad-y` 算出来，
   * CSS 变量一改，写死的虚拟滚动就会错位（而且它错位是静默的：滚动条长度不对、滚着滚着跳）。
   */
  let archiveRowHeight = 0
  function rowHeight(): number {
    if (archiveRowHeight > 0) return archiveRowHeight
    const probe = document.createElement('li')
    probe.className = 'item'
    probe.style.visibility = 'hidden'
    archiveList.append(probe)
    archiveRowHeight = Math.round(probe.getBoundingClientRect().height) || 38
    probe.remove()
    return archiveRowHeight
  }

  /**
   * 只渲染视口里的那几十行，用上下两个**撑高的占位行**维持滚动条。
   *
   * 行高是定值（所有行都是 `--row-height`，扁平之后连「展开块」这种不等高的东西也没有了），
   * 所以第 i 行的位置就是 `i * rowHeight`——不需要测量每一行。
   */
  function renderArchiveWindow(): void {
    if (archiveRows.length === 0) return
    const height = rowHeight()
    const total = archiveRows.length * height
    const viewTop = Math.max(0, archiveBox.scrollTop)
    const viewHeight = archiveBox.clientHeight || height * 20
    const first = Math.max(0, Math.floor(viewTop / height) - ARCHIVE_OVERSCAN)
    const last = Math.min(
      archiveRows.length,
      Math.ceil((viewTop + viewHeight) / height) + ARCHIVE_OVERSCAN
    )

    const parts: string[] = []
    if (first > 0) parts.push(`<li class="vpad" style="height:${first * height}px"></li>`)
    for (let index = first; index < last; index++) parts.push(archiveRowMarkup(archiveRows[index]))
    const rest = total - last * height
    if (rest > 0) parts.push(`<li class="vpad" style="height:${rest}px"></li>`)

    archiveList.innerHTML = parts.join('')
    syncArchiveStates()
  }

  /**
   * 把某一行滚进视野（新建 / 改名的那一行可能落在视口外，`focusRenameInput()` 会抓不到输入框）。
   *
   * **两步：先按行高估一次，渲染出来再量真实位置修正。**
   *
   * 只靠估算不够：列表上面还压着一条**吸顶**的面包屑（`.box__top`），它占着滚动内容的一段高度、
   * 滚动时又盖在内容上，再加上取整，估算会差几个像素甚至**一整行**——
   * 而这一行的用户可见后果就是「新建的东西没滚到、还在屏幕外」。
   * 量一次真实元素就没有这些假设了：它同时得到了吸顶栏遮挡区与真实边界。
   */
  function scrollRowIntoView(id: string): void {
    const index = archiveRows.findIndex((row) => row.kind === 'node' && row.node.id === id)
    if (index < 0) return
    const height = rowHeight()
    const boxRect = archiveBox.getBoundingClientRect()
    const listTop = archiveList.getBoundingClientRect().top - boxRect.top + archiveBox.scrollTop
    const rowTop = listTop + index * height

    const sticky = archiveBox.querySelector('.box__top')
    const occluded = sticky ? Math.max(0, sticky.getBoundingClientRect().bottom - boxRect.top) : 0
    if (rowTop < archiveBox.scrollTop + occluded) archiveBox.scrollTop = rowTop - occluded
    else if (rowTop + height > archiveBox.scrollTop + archiveBox.clientHeight) {
      archiveBox.scrollTop = rowTop + height - archiveBox.clientHeight
    }

    // 修正：把这一行渲染出来、量它真实的位置，差多少补多少（最多再渲染一次）。
    renderArchiveWindow()
    const target = [...archiveList.querySelectorAll<HTMLElement>('[data-node-id]')].find(
      (row) => row.dataset.nodeId === id
    )
    if (!target) return
    const rect = target.getBoundingClientRect()
    const limitTop = boxRect.top + occluded
    const limitBottom = boxRect.bottom
    let delta = 0
    if (rect.top < limitTop) delta = rect.top - limitTop
    else if (rect.bottom > limitBottom) delta = rect.bottom - limitBottom
    if (delta !== 0) {
      archiveBox.scrollTop += delta
      renderArchiveWindow()
    }
  }

  /**
   * 滚动时重画窗口。用 `requestAnimationFrame` 合并同一帧里的多次 scroll。
   *
   * **正在改名时不重画**：输入框会被换掉，而 `focusout` 处理器会把「元素被移除」当成
   * 「用户点开了别处」从而提交改名——打字打到一半被提交是最糟的结果。
   * 改名期间本来也不该滚动列表。
   */
  let archiveWindowQueued = false
  function scheduleArchiveWindow(): void {
    if (renaming || archiveWindowQueued) return
    archiveWindowQueued = true
    requestAnimationFrame(() => {
      archiveWindowQueued = false
      renderArchiveWindow()
    })
  }
  archiveBox.addEventListener('scroll', scheduleArchiveWindow, {passive: true})

  /**
   * 这一行该不该有勾选框。
   *
   * **判据是「这一行在不在『打开』的范围内」**，与 `archiveBookmarkIds()` 严格同一口径：
   * 那个集合只覆盖「当前层的书签 + 每个直属子文件夹里的书签」（depth ≤ 1），
   * 因为 `restoreFolder` 只处理一层（子文件夹建分组、散装书签不建分组）。
   * 文件夹行同理，只有**当前层的直属子文件夹**（depth 0）才有意义。
   *
   * 更深层的行是行内展开 / 全部展开才看得见的，它们**不会被打开**，所以不给勾选框：
   * 给了就是一句假话（勾了却不开），而「列表看着全选、按钮说没选中」正是这个项目
   * 反复要避免的那类错觉——全部展开会让它一次性放大到近万行。
   *
   * 另外整个开关在 `selectable` 上：两栏都是收藏夹时根本没有勾选这回事（见 `setSelectable`）。
   */
  function selectableAt(depth: number, isFolder: boolean): boolean {
    if (!selectable) return false
    return isFolder ? depth === 0 : depth <= 1
  }

  /**
   * 这一栏要不要显示勾选框（见 `ArchivePane.setSelectable`）。
   *
   * 窗口档下的右栏要：勾选驱动「打开 (N)」。两栏都是收藏夹时不要。
   */
  let selectable = true

  /**
   * 切换勾选框的显示，并当场重画。
   *
   * **不重读书签树**：这一档只影响列两行的长相，数据早就手上（与展开文件夹同一个道理）。
   * 全选框那一行也要跟着收起——只剩右端那几枚按钮（那一行本来就是它们的容身之处）。
   */
  function setSelectable(enabled: boolean): void {
    if (selectable === enabled) return
    selectable = enabled
    archiveSelectAll.input.closest('label')?.toggleAttribute('hidden', !enabled)
    renderArchive()
  }

  /** 没有勾选框的行用它占位：`.marker__slot` 与复选框实测都是 14px，不给就会整列左移一格。 */
  const NO_BOX_SLOT = '<span class="marker__slot" aria-hidden="true"></span>'

  /**
   * 行首那一格。
   *
   * 三种情况：
   * - **给勾选框**：这一行在「打开」的范围内（见 `selectableAt`）。
   *   分隔线永远不给（它不是书签，传 `undefined`）。
   * - **给等宽占位**：同一份清单里别的行有勾选框，不给占位它们就会差一格（`NO_BOX_SLOT`）。
   * - **什么都不给**：整栏都不要勾选框时（两栏都是收藏夹，见 `setSelectable`）。
   *   那时没有任何一行有勾选框，再留一列空白就只是让每一行的文字白白右移 14px。
   */
  function boxSlot(id: string | undefined, depth: number, isFolder: boolean): string {
    if (id !== undefined && selectableAt(depth, isFolder)) {
      return `<input type="checkbox" data-archive-item="${escapeHtml(id)}" />`
    }
    return selectable ? NO_BOX_SLOT : ''
  }

  /** 一条行的 HTML（三类行 + 空文件夹提示，都在这里分派）。 */
  function archiveRowMarkup(row: ArchiveRow): string {
    if (row.kind === 'empty') {
      return `<li class="kids__empty" style="--depth:${row.depth}">这个文件夹是空的</li>`
    }
    return row.node.url ? archiveBookmarkRow(row) : archiveFolderRow(row)
  }

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
  function archiveBookmarkRow(row: ArchiveNodeRow): string {
    const bookmark = row.node
    // 三样东西每行都要带上：所在层（拖拽算插到哪一层的第几格）、层内下标（同一件事，
    // 但不必再去 DOM 里数兄弟）、缩进（扁平之后层级只能这样表达）。
    // `data-node-id` 是给「把这一行滚进视野」按 id 定位元素用的。
    const boxAttrs = `data-parent-id="${escapeHtml(row.parentId)}" data-sibling-index="${row.siblingIndex}" style="--depth:${row.depth}"`
    const nodeAttr = `data-node-id="${escapeHtml(bookmark.id)}"`
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
            ${boxAttrs} ${nodeAttr} data-drag-separator="${escapeHtml(bookmark.id)}">
          ${boxSlot(undefined, row.depth, false)}
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
          ${boxAttrs} ${nodeAttr} data-drag-bookmark="${escapeHtml(bookmark.id)}"
          data-bookmark-url="${escapeHtml(url)}">
        ${boxSlot(bookmark.id, row.depth, false)}
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
   * 一个子文件夹行。它同时支持两种「往里看」的方式，两者是两码事：
   *
   * - **双击这一行（或点「进入」）= 进这一层**：把它变成当前展示的文件夹，`viewFolderId` 跟过去，
   *   面包屑负责往回走。也就是说「我现在就在这一层干活」（往它里面存东西、接着往下看）。
   * - **点左侧那枚方块 = 就地展开**（Finder 的列表视图那样）：子级直接推开在下面，换页不离开。
   *   适合「我只想看一眼里面有什么、不想丢掉手上的上下文」（比如往父层存东西时先看看里面）。
   *   方块平时是文件夹图标，悬停 / 聚焦时换成折叠三角（见 `icons.ts`）。
   *
   * 那两个计数仍是**直属**的，没有因为能展开就改成递归——口径与「打开（N）」、勾选框保持一致（见下）。
   */
  function archiveFolderRow(row: ArchiveNodeRow): string {
    const folder = row.node
    // 两个计数都保持**直属**，而且只算真书签（分隔线不是书签，算进去会与文件管理器的直觉不符）。
    //
    // 「直属」而不是递归到后代，是为了让这一行上的三个数字**同一口径**：
    // 勾选框只勾这一层的书签，「打开（N）」也只算这一层（`restoreFolder` 的处理口径）。
    // 三者一致，才能一眼看出「勾上它、点打开，会开几枚标签页」——
    // 递归数字（例如 312）跟着的却是一个只能勾 18 条的勾选框，反而让人以为勾了会开 312 个。
    // （递归计数不要钱：`getSubTree()` 本来就把整棵子树读进来了，纯内存遍历实测 0.4ms/万条。）
    //
    // 所以**展开也不改计数**：展开只是多看到几行，这一行的勾选框、副文案与「打开（N）」
    // 说的还是「这一层」。
    const children = folder.children ?? []
    const bookmarks = realBookmarks(children)
    const folderCount = children.filter((child) => !child.url).length
    const isRenaming = renaming?.id === folder.id
    const editable = !atTreeRoot()
    const expanded = row.expanded

    const title = isRenaming
      ? `<input type="text" class="input input--rename" draggable="false"
                data-rename-input="${escapeHtml(folder.id)}"
                value="${escapeHtml(folder.title)}" aria-label="重命名文件夹" />`
      : `<span class="item__title">${escapeHtml(folder.title)}</span>`

    // 「进入」永远有；「改名 / 删除」只在可编辑的层上给（见函数注释）。
    const enterButton = `<button type="button" class="btn btn--ghost btn--sm" data-enter="${escapeHtml(folder.id)}">进入</button>`
    const editButtons = editable
      ? `<button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(folder.id)}">改名</button>
         ${
           pendingDeleteId === folder.id
             ? `<button type="button" class="btn btn--danger btn--sm" data-confirm-delete="${escapeHtml(folder.id)}">确认删除</button>
                <button type="button" class="btn btn--ghost btn--sm" data-cancel-delete="">取消</button>`
             : `<button type="button" class="btn btn--ghost btn--sm" data-delete="${escapeHtml(folder.id)}">删除</button>`
         }`
      : ''
    const actions = isRenaming
      ? ''
      : `<span class="tree__actions">${enterButton}${editButtons}</span>`

    return `
      <li class="item group__head${expanded ? ' is-expanded' : ''}" data-row data-drop-row="folder"
          data-parent-id="${escapeHtml(row.parentId)}" data-sibling-index="${row.siblingIndex}"
          style="--depth:${row.depth}" data-node-id="${escapeHtml(folder.id)}"
          data-drop-folder="${escapeHtml(folder.id)}" data-enter-folder="${escapeHtml(folder.id)}">
        ${boxSlot(folder.id, row.depth, true)}
        <button type="button" class="folder-tile" data-toggle-folder="${escapeHtml(folder.id)}"
                aria-expanded="${expanded}"
                title="${expanded ? '收起这一层' : '就地展开这一层（不换页）'}"
                aria-label="${expanded ? '收起' : '展开'}${escapeHtml(folder.title)}">${FOLDER_ICON}${CHEVRON_ICON}</button>
        <span class="item__main item__main--row" draggable="true"
              data-drag-folder="${escapeHtml(folder.id)}" title="双击进入这一层">
          ${title}
          <span class="item__meta">${bookmarks.length} 个书签 • ${folderCount} 个文件夹</span>
        </span>
        ${actions}
      </li>
    `
  }

  /**
   * 当前展示的是不是书签树的**根**。
   *
   * 根是唯一一个没有父的节点，所以「路径只有一层」就是「是不是根」——
   * 不需要把 id `0` 这个魔法值写进业务代码。
   *
   * 它是两个不同结论的**同一个依据**，所以只判一次、两处引用，不要各写一遍 `viewPath.length`：
   * - 它只是三个内置目录的容器，Chrome 不接受在它下面直接建书签 / 文件夹 → `canWrite()`；
   * - 它的三个子级是固定文件夹，改名与删除都会被浏览器拒绝 → 行内不给那两个按钮。
   */
  function atTreeRoot(): boolean {
    return viewPath.length <= 1
  }

  /**
   * 能不能往当前这一层写。
   *
   * 书签树的根只是三个内置目录的容器，Chrome 不接受在它下面直接建书签/文件夹，
   * 所以导航到那里时「存过去」、「新建文件夹」与「＋ 分隔线」「＋ 间隔」都要禁用。
   */
  function canWrite(): boolean {
    return !atTreeRoot()
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
    archiveNote.textContent = '这里是书签树的根，Chrome 不允许直接在它下面放东西。双击下面任意一个文件夹进去即可。'
  }

  function renderArchive(): void {
    renderArchivePath()
    // 胸章数的是「这一层里能干活的东西」：子文件夹可以进去，书签可以打开。分隔线两样都不是。
    archiveCount.textContent = String(
      archiveChildren.filter((child) => !child.url).length + realBookmarks(archiveChildren).length
    )

    if (!viewFolderId) {
      archiveList.innerHTML =
        '<li class="empty">读不到书签栏，这一栏无法显示内容。</li>'
      // 早退分支**必须**也调同步：全选框的文案与三态在它里面算，
      // 漏掉就会停在上一次的层（实测从一层进到空文件夹时，右上角还写着「已选 0 / 234 个标签页」）。
      syncArchiveStates()
      return
    }

    if (archiveChildren.length === 0) {
      // 文案**不写「左侧」「右栏」**：两栏都可能是收藏夹（F7），写死方向在另一栏里就是错的。
      archiveList.innerHTML = canWrite()
        ? '<li class="empty">这个文件夹还是空的。从另一栏拖一条过来即可。</li>'
        : '<li class="empty">这里是书签树的根，只能往下走。点下面的「书签栏」进去吧。</li>'
      syncArchiveStates()
      return
    }

    archiveRows = flattenArchive()
    // 编辑中的那一行、或刚存下的那一个文件夹，都可能不在视口里
    // （新建的文件夹落在末尾）。先把它滚进来再渲染窗口：否则 `focusRenameInput()`
    // 抓不到输入框，用户也看不到自己刚建的东西。
    if (renaming) scrollRowIntoView(renaming.id)
    if (pendingScrollId) {
      scrollRowIntoView(pendingScrollId)
      pendingScrollId = undefined
    }
    renderArchiveWindow()
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
      // 查找走索引而不是 `archiveChildren`：展开之后，勾选框可能属于**后代**里的某一层。
      const node = nodeIndex.get(id)
      const folder = node && !node.url ? node : undefined
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

  const NAVIGATION_GUARD_MS = 350

  /** 跳到某一层（双击子文件夹、点「进入」、点面包屑、点「上一层」都走这里）。 */
  async function navigateTo(folderId: string): Promise<void> {
    if (flags.busy || !folderId || folderId === viewFolderId) return
    const now = Date.now()
    if (now - lastNavigationAt < NAVIGATION_GUARD_MS) return
    lastNavigationAt = now

    // 换层时把行内编辑状态与展开状态都丢掉：那些行已经不在眼前了。
    // 展开状态**不跟着走**是为了不让它越攒越多——一个层的展开与否只对那一层的浏览有意义。
    renaming = undefined
    pendingDeleteId = undefined
    expandedIds.clear()
    viewFolderId = folderId
    // 换层之后从头看：上一次停在中途的位置对新的一层没有意义。
    archiveBox.scrollTop = 0
    await refresh()
  }

  /**
   * 重新决定右栏落在哪一层。
   *
   * 顺序是「第一个**可用**的收藏 → 书签栏自身 → 空」：
   * 收藏里可能已经删掉了几个，所以不能只看第一个；一个收藏都没有时落到书签栏——
   * 那是唯一一个“总是有意义”的层（它下面全是用户的文件夹，可以直接往下走）。
   * 书签栏都读不出来（数据异常）才真的空着，此时 `viewFolderId` 清空，让右栏去渲染空态。
   */
  async function landOnStart(): Promise<void> {
    for (const id of deps.favoriteIds()) {
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

    // 重建索引：当前层 + 所有后代。展开某一层不需要再读一次书签树（数据已经在手上，
    // 因为 `getSubTree()` 本来就是递归的），这里重建的只是查找表。
    nodeIndex = new Map()
    parentById = new Map()
    const indexTree = (nodes: readonly BookmarkNode[]): void => {
      for (const node of nodes) {
        nodeIndex.set(node.id, node)
        for (const child of node.children ?? []) parentById.set(child.id, node.id)
        if (node.children) indexTree(node.children)
      }
    }
    indexTree(archiveChildren)
    // 顶层这几条的父就是当前这一层，而 `indexTree` 只记了「节点 → 它的子级」，
    // 所以补一次：不补的话 `parentOf()` 对它们返回 undefined（搬东西时判「本来就在这一层」要用）。
    for (const child of archiveChildren) parentById.set(child.id, viewFolderId)

    // 展开集只保留还看得见的那些：删掉一个文件夹之后再刷新，它的 id 留在集合里没害处，
    // 但集合没理由越攒越大。
    for (const id of [...expandedIds]) if (!nodeIndex.has(id)) expandedIds.delete(id)

    /*
     * 刚存下的分组默认展开，而且**连它的祖先一起展开**。
     *
     * 两层都要的理由不同：展开自己是「拖过去之后马上看到里面存了什么」；
     * 展开祖先是必需的——落点可以是一个**收起的**文件夹（拖到它那一行的中间就进它里面），
     * 只展开自己的话，那个展开根本不在视野里，看着就像没生效。
     */
    for (const id of pendingExpandIds) {
      if (nodeIndex.has(id)) expandedIds.add(id)
      for (
        let at = parentById.get(id);
        at !== undefined && at !== viewFolderId;
        at = parentById.get(at)
      ) {
        expandedIds.add(at)
      }
    }
    pendingExpandIds = []

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
    // 现在 `viewPath` / `archiveChildren` 都是新的了，叫面板把中间那一列也算一遍。
    deps.onStateChanged()
  }

  /**
   * 右栏的落点：进某个文件夹，或插到某一层的某个位置。
   *
   * 三类行（文件夹 / 书签 / 分隔线）都是可锚定的——分隔线虽然只是个记号，
   * 但用户可以把它拖到任意两条之间，所以它不是特殊行。
   *
   * 两处与虚拟滚动 / 行内展开有关的细节：
   *
   * - 插入下标读行上的 `data-sibling-index`，**不再去 DOM 里数兄弟**：
   *   虚拟滚动之后视口外的行根本不存在，扫 DOM 会数出一个错的层内下标。
   * - 行里没有嵌套子级了（扁平渲染），所以三分法直接量这一行，不必再找 `.group__head`。
   */
  function archiveDropSpot(event: DragEvent): ArchiveDrop | undefined {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>(
      '[data-drop-row="bookmark"], [data-drop-row="folder"], [data-drop-row="separator"]'
    )
    if (!row) return undefined

    const isFolder = row.dataset.dropRow === 'folder'
    const spot = spotIn(row, event.clientY, isFolder)
    if (isFolder && spot === 'into') return {kind: 'into', folderId: row.dataset.dropFolder ?? ''}
    const siblingIndex = Number(row.dataset.siblingIndex ?? 0)
    return {
      kind: 'here',
      parentId: row.dataset.parentId ?? viewFolderId,
      index: spot === 'after' ? siblingIndex + 1 : siblingIndex,
      after: spot === 'after'
    }
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
    if (flags.busy || !canWrite()) return
    if (spot && !canDropAt(payload, dropTargetId(spot))) {
      // 兜底：正常路径上 `dragover` 已经把 dropEffect 置成 none、drop 不会派发，
      // 但万一走到了这里，绝不能报「已调整收藏夹顺序」——那是假话，实际什么都没做。
      setStatus(status, '不能把文件夹挪进它自己里面。', 'error')
      return
    }

    // **不置灰按钮**：`busy` 只是防重入（上面的守卫），而这一步几乎是瞬时的。
    // 一旦在这里调 `updateButtons()`，中间那排按钮会先变灰再恢复——用户看到的就是「按钮闪一下」。
    // 真会花时间的操作（保存一整窗、打开几十个标签）才该置灰，见 `writeInto` / `openSelection`。
    flags.busy = true
    try {
      if (spot?.kind === 'into') {
        // 不给 index：`bookmarks.move` 省略 index 就是追加到末尾。
        await chrome.bookmarks.move(payload.id, {parentId: spot.folderId})
      } else {
        await chrome.bookmarks.move(payload.id, {
          parentId: spot?.kind === 'here' ? spot.parentId : viewFolderId,
          index: spot?.kind === 'here' ? spot.index : archiveChildren.length
        })
      }
      setStatus(status, '已调整收藏夹顺序。', 'ok')
    } catch (error) {
      setStatus(status, `调整失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      await events.archiveChanged()
    }
  }

  /**
   * 这个落点收不收这一份拖拽载荷。
   *
   * 两种情况不行，而它们以前都不可能发生（右栏一次只显示一层，落点的锚点永远是兄弟）：
   *
   * 1. **拖到自己身上**。
   * 2. **拖进自己的子孙里**——行内展开之后这个动作点得到（展开 A，再把 A 拖到它里面那层）。
   *    Chrome 会拒绝它（会形成环），但我们不能等到报错：那会在界面上留下
   *    「拖了但没动」而没有任何解释的痕迹。所以先沿父链走一遍自己判断。
   *
   * 两个落点都要过这一关：`into` 时目标是那个文件夹，`here` 时目标是**它所在的那一层**
   * （把 A 拖进 A 里面的某个位置，一样是环）。
   */
  function canDropAt(payload: DragPayload, targetId: string): boolean {
    if (payload.kind !== 'folder') return true
    if (payload.id === targetId) return false
    for (let at = parentById.get(targetId); at !== undefined; at = parentById.get(at)) {
      if (at === payload.id) return false
    }
    return true
  }

  /** 落点对应的「收件层」是哪一个（`into` 是那个文件夹，`here` 是它所在的那一层）。 */
  function dropTargetId(spot: ArchiveDrop): string {
    return spot.kind === 'into' ? spot.folderId : spot.parentId
  }

  /**
   * 就地展开 / 收起一个文件夹（点左侧那枚方块）。
   *
   * 不 `await` 任何东西、也不重新读书签树：`getSubTree()` 已经把整棵子树读进来了，
   * 子级就在 `folder.children` 里。所以这一步只是把 id 记进 `expandedIds` 再重绘。
   * 重绘不会丢掉展开状态（它在模块状态里，不在 DOM 里），也会走 `syncArchiveStates()` 把
   * 新出现的勾选框回填成正确的样子。
   */
  function toggleFolder(id: string): void {
    const node = nodeIndex.get(id)
    if (!node || node.url) return
    // 默认浏览器行为之外的东西都不要：拖拽与展开是两种手势，别让行上的拖动把它带走。
    if (expandedIds.has(id)) expandedIds.delete(id)
    else expandedIds.add(id)
    renderArchive()
  }

  /**
   * 这一棵子树里**可以展开**（有子级）的文件夹数量。
   *
   * 空文件夹不算：展开它只会多出一行「这个文件夹是空的」，而那一行的副文案
   * （「0 个书签 • 0 个文件夹」）已经把同一件事说完了。
   */
  function expandableCount(): number {
    let count = 0
    for (const node of nodeIndex.values()) {
      if (!node.url && (node.children?.length ?? 0) > 0) count++
    }
    return count
  }

  /**
   * 全部展开 / 全部折叠（一个按钮两档，像行内那个「转成另一种」）。
   *
   * 它不是「树视图」，而是给已经展开的那几层加一个「一次全看完」的手势：
   * 找东西时一排排点开二十几个文件夹很磨人，而全部展开之后可以用浏览器自己的
   * 页内查找（Ctrl+F）在一屏里找——那是这一档真正解决的问题。
   *
   * **有展开的就全部收起，否则全部展开**：不需要第二个按钮，按钮上的字已经说明了下一档是什么。
   * 判据看的是 `expandedIds` 而不是`当前层里有没有可见的己展开项`——
   * 展开集在换层时会清空，所以两者实际总是一致，但前者不用再走一遍 DOM。
   *
   * 代价（实测量过，不是估计）：真实数据下书签栏子树全部纳入展开集是
   * **11003 行 / 11.5 万个元素 / 12 MB 的 HTML**。所以这个手势必须配**虚拟滚动**
   * （只渲染视口里那几十行，见 `renderArchiveWindow`）——否则一次 `innerHTML` 就是
   * 983 ms 卡顿 + 2402 ms 布局。展开本身是纯内存操作（约 20 ms），贵的是渲染。
   */
  function toggleExpandAll(): void {
    if (expandedIds.size > 0) {
      expandedIds.clear()
    } else {
      for (const [id, node] of nodeIndex) {
        if (!node.url && (node.children?.length ?? 0) > 0) expandedIds.add(id)
      }
    }
    renderArchive()
  }

  /** 要开成标签的那几条（书签就是它自己；文件夹取它直属的真书签，内部页面跳过）。 */
  function archiveOpenItems(payload: DragPayload): {url: string}[] {
    if (payload.kind === 'bookmark') {
      const url = bookmarkUrl(payload.id)
      return url && !isInternalUrl(url) ? [{url}] : []
    }
    if (payload.kind !== 'folder') return []

    const folder = nodeIndex.get(payload.id)
    return realBookmarks(folder?.children ?? [])
      .map((node) => node.url as string)
      .filter((url) => !isInternalUrl(url))
      .map((url) => ({url}))
  }

  function archiveFolderTitle(id: string): string | undefined {
    // 不带 `!node.url` 的判断：调用方只会拿文件夹的 id（它要给新建的分组起名），
    // 而索引里给出的就是那个节点。
    return nodeIndex.get(id)?.title
  }

  function bookmarkUrl(id: string): string | undefined {
    return nodeIndex.get(id)?.url
  }

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

    const toggleButton = target.closest<HTMLButtonElement>('[data-toggle-folder]')
    if (toggleButton?.dataset.toggleFolder) {
      toggleFolder(toggleButton.dataset.toggleFolder)
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
    const node = nodeIndex.get(id)
    return node !== undefined && isRealBookmark(node)
  }

  /** 弹窗改一条书签的标题与网址。取消时什么都不做。 */
  function editBookmark(id: string): void {
    const node = nodeIndex.get(id)
    if (!node) return
    openBookmarkDialog(
      root,
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
    const node = nodeIndex.get(id)
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
    if (flags.busy) return
    // 只立 `busy`（防重入）而**不置灰按钮**：删一条几乎是瞬时的，而「置灰 → 恢复」
    // 会让一整排按钮闪一下（与 moveArchiveNode 同一个理由）。
    flags.busy = true
    pendingDeleteId = undefined
    try {
      await removeSubTree(id)
      // 删的是当前层里的子项，所以视图本身不用动——删掉之后再刷新自然少一行。
      setStatus(status, '已删除。', 'ok')
    } catch (error) {
      setStatus(status, `删除失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      await events.archiveChanged()
    }
  }

  // 「打开书签管理器」开的就是当前展示的这一层：给管理器的 `?id=` 一个数字 id，
  // 它就能直接落在那一层（Chrome 154.x 上这个入口有个已知回归，见 `bookmarkManagerUrl`）。
  openRootButton.addEventListener('click', async () => {
    if (!viewFolderId) return
    try {
      await openInBookmarkManager(viewFolderId)
      setStatus(status, '书签管理器已打开。', 'ok')
    } catch (error) {
      // 这里的错误文案是写给用户看的（含快捷键），不是 API 的原文，所以直接展示。
      setStatus(status, errorText(error), 'error')
    }
  })

  newFolderButton.addEventListener('click', async () => {
    if (!canWrite() || flags.busy) return    flags.busy = true
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
      flags.busy = false
      updateButtons()
    }
  })

  // 两种记号各一个按钮，**不合并成一个再让用户去改**：它们外观完全不同，
  // 建完再转一次是多余的一步（而且刚建的那一枚还分不清是哪种）。
  // 建完直接进入改名状态：它的全部意义常常就在那个标题上。
  async function createMarker(kind: SeparatorKind): Promise<void> {
    if (!canWrite() || flags.busy) return
    flags.busy = true
    updateButtons()
    try {
      const created = await createBookmark(viewFolderId, '', separatorUrlOf(kind))
      deps.rememberWrite({folderIds: [], bookmarkIds: [created.id]})
      renaming = {id: created.id, committed: false}
      await events.archiveChanged()
      await refresh()
      focusRenameInput()
    } catch (error) {
      setStatus(status, `新建失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
      updateButtons()
    }
  }

  newSeparatorButton.addEventListener('click', () => void createMarker('sep'))
  newGapButton.addEventListener('click', () => void createMarker('gap'))

  // 全部展开 / 全部折叠：不置灰按钮、不写状态行——它不是耗时操作，也不改变任何数据，
  // 行数当场变了一下就是它的全部反馈（与展开单个文件夹一致）。
  expandAllButton.addEventListener('click', () => toggleExpandAll())

  /**
   * 把一枚记号在两种形态之间转换（分隔线 ⇄ 间隔）。
   *
   * 只改 `url`：两种记号的差别就在那个 `?t=horz`，而标题是用户自己写的，
   * 与它是横线还是竖线无关——顺手把标题也改掉会丢掉用户写的东西。
   */
  async function swapSeparator(id: string): Promise<void> {
    if (flags.busy) return
    const kind = separatorKind(nodeIndex.get(id)?.url)
    if (!kind) return
    const next = toggledSeparatorKind(kind)

    flags.busy = true
    pendingDeleteId = undefined
    try {
      await updateNode(id, {url: separatorUrlOf(next)})
      setStatus(status, `已改成${SEPARATOR_LABELS[next]}。`, 'ok')
    } catch (error) {
      setStatus(status, `转换失败：${errorText(error)}`, 'error')
    } finally {
      flags.busy = false
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
  /**
   * 重新读自己这一层并重绘。
   *
   * 视图落点能留在原地就留在原地——用户在浏览收藏夹，不该因为一次刷新被弹回起点。
   * 只有当前层真的没了（被删掉 / 被挪到别处）才重新找一层。
   */
  async function refresh(): Promise<void> {
    viewPath = viewFolderId ? await getNodePath(viewFolderId) : []
    if (viewPath.length === 0) await landOnStart()
    applyArchive(viewFolderId ? await getSubTree(viewFolderId) : undefined)
  }

  /** 展开刚存下的那几个文件夹，并记住要把哪一个滚进视野。 */
  function expandOnNextReload(ids: readonly string[], scrollId?: string): void {
    pendingExpandIds = [...ids]
    pendingScrollId = scrollId
  }

  /**
   * 本实例里那几个按钮的可用状态。
   *
   * **与面板那一份分开写**：中间那一列（存过去 / 打开 / 新窗口 / 撤销）属于面板，
   * 这几个属于本栏。合成一个函数会让两栏的模式切换变成「谁的按钮在谁手里」的猜谜。
   */
  function updateButtons(): void {
    newFolderButton.disabled = flags.busy || !canWrite()
    newSeparatorButton.disabled = flags.busy || !canWrite()
    newGapButton.disabled = flags.busy || !canWrite()
    // 全部展开 / 全部折叠：字跟着状态走（有展开的就写「全部折叠」），
    // 而它在两种情况下没得按——这一层没有可展开的子文件夹，或者正忙。
    // 注意它**不看** `canWrite()`：书签树的根不能写，但「把这几棵树都推开看一眼」完全说得通。
    const hasExpanded = expandedIds.size > 0
    expandAllButton.textContent = hasExpanded ? '全部折叠' : '全部展开'
    expandAllButton.title = hasExpanded ? '把展开的子级都收起来' : '把这一层下面的文件夹全部推开'
    expandAllButton.disabled = flags.busy || (!hasExpanded && expandableCount() === 0)
    // 与它并排的刷新按钮**不置灰**，而它要灰：它依赖「当前站在哪一层」，站得不对时按了没意义。
    // 用 `disabled` 而不是 `hidden`：hidden 会让它凭空出现 / 消失，而右边那个刷新按钮
    // 靠 `margin-left: auto` 贴右，位置不会因为它的出现而变——但同行里凭空多一个东西
    // 看着就像整排跳了一下。
    openRootButton.disabled = !viewFolderId
  }

  /** 本栏全选框那一行的容器（面板往里面塞刷新按钮）。 */
  const actionsHost = q<HTMLDivElement>(root, id('all-host'))

  return {
    list: archiveList,
    actionsHost,
    openRootButton,
    isWritable: canWrite,
    currentFolderId: () => viewFolderId,
    currentFolderTitle: () => viewPath.at(-1)?.title ?? '',
    keptCount: archiveKeptCount,
    setSelectable,
    excluded: () => archiveExcluded,
    reload: refresh,
    navigateTo,
    updateButtons,
    handleChange,
    dropSpot: archiveDropSpot,
    canDropAt,
    dropTargetId,
    moveNode: moveArchiveNode,
    openItems: archiveOpenItems,
    folderTitle: archiveFolderTitle,
    expandOnNextReload
  }

  /**
   * 本栏的勾选框变了（面板把 `change` 事件整个接过去，再分发给两栏）。
   *
   * 返回 true 表示这个输入框属于本实例——面板据此决定要不要再往左栏那些分支里找。
   */
  function handleChange(input: HTMLInputElement): boolean {
    const itemId = input.dataset.archiveItem
    if (itemId === undefined) return false
    const node = nodeIndex.get(itemId)
    const folder = node && !node.url ? node : undefined
    if (folder) {
      const ids = folderBookmarkIds(folder)
      const kept = ids.filter((id) => !archiveExcluded.has(id)).length
      // 不读原生取反的结果：部分选择时它会变成「全不选」，与惯例相反。
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
    // 勾选变了，「打开 (N)」要跟着变。
    deps.onStateChanged()
    return true
  }
}
