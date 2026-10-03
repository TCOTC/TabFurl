/*
 * 收藏夹面板的一个实例（右栏一个；左栏切成收藏夹时再一个）。
 *
 * 复制一份实现行不通：两份一定会分叉。面板只提供**位置**与几个回调（见 `ArchivePaneDeps`），
 * 「我站在哪一层、展开了哪些、勾掉了哪些」都是本实例自己的。
 *
 * 三条历史结论，不要因为「看着像优化」而改掉：虚拟滚动（全展开 11004 行，只能渲染视口那几十行）、
 * 行高从真实元素量（CSS 变量一改，写死的会静默错位）、签名用 `JSON.stringify` 拼（手写分隔符有错前提）。
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
import {escapeHtml} from '../shared/tile'
import type {BookmarkNode} from '../shared/types'
import {
  SEPARATOR_LABELS,
  isInternalUrl,
  isSeparatorUrl,
  separatorKind,
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
import {archiveBookmarkIds, countValue, folderBookmarkIds, keptCount} from './archiveCounts'
import {canDropTo, dropTargetId} from './archiveDrop'
import {archiveRowMarkup, type MarkupContext} from './archiveMarkup'
import {pickOwnerOf, rangeBetween, topLevelPicked} from './archivePick'
import {flattenArchive, type ArchiveRow} from './archiveRows'
import {openBookmarkDialog} from './BookmarkDialog'

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
   * 这一层里「会被看见的东西」有多少：子文件夹可以进去，书签可以打开，分隔线两样都不是。
   *
   * 面板拿它去写左栏表头那**唯一一枚**胸章（那一枚两档共用一个，见 `TransferPanel`）。
   * 右栏自己有胸章，所以它不用这个方法。
   */
  count(): number
  /**
   * 这一栏要不要显示勾选框。
   *
   * 窗口档下右栏要（勾选驱动「存过去 / 打开 (N)」）；而**两栏都是收藏夹时两栏都不要**：
   * 那一档完全靠拖拽（拖哪一行就搬哪一行），勾选框在那里只会让人以为
   * 「先勾上、再点中间的按钮」——而中间那一列在那个档下整个不在了。
   */
  setSelectable(enabled: boolean): void
  /**
   * 这一条现在挂在哪一层。
   *
   * 批量搬运时用它判「它本来就在目的地那一层」——那种情况不该再 `move` 一次：
   * 同一个父级下省略 index 是**追加到末尾**，而用户要的显然不是「把这几个排到最后」。
   */
  parentOf(nodeId: string): string | undefined
  /** 拖动这一行时该带走哪些 id（多选时是整批；`undefined` = 就拖这一行）。 */
  dragIdsOf(row: HTMLElement): string[] | undefined
  /** 本栏选中的条目（规约过的顶层项），写进拖拽载荷用。 */
  selectionIds(): string[]
  /** 清空本栏的多选（换档、换层、以及搬完之后）。 */
  clearPick(): void
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

  const archiveCount = root.querySelector<HTMLSpanElement>(id('count'))
  const archivePath = q<HTMLElement>(root, id('path'))
  const archiveNote = q<HTMLParagraphElement>(root, id('note'))

  const expandAllButton = q<HTMLButtonElement>(root, id('expand-all-btn'))
  const clearPickButton = q<HTMLButtonElement>(root, id('clear-pick-btn'))
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
      for (const id of archiveBookmarkIds(archiveChildren)) {
        if (wantAll) archiveExcluded.delete(id)
        else archiveExcluded.add(id)
      }
      syncArchiveStates()
      deps.onStateChanged()
    }
  })

  /**
   * 右栏当前展示的哪一层（也是**写入目标**）。
   *
   * 「可导航的浏览器 + 就地展开」两层并存：双击子文件夹行进去、面包屑退回，
   * 同时行首那枚方块可以就地推开子级。**没有「上一层」按钮**——退路就是面包屑。
   * 理由见 `docs/design.md` 七。
   */
  let viewFolderId = ''

  /**
   * 当前层的完整路径（含自身），面包屑用它。
   * 与 `expandedIds` 是两件事：「我站在哪一层」 vs 「一眼多看了几层」（Finder 的列表视图也是两者并存）。
   */
  let viewPath: {id: string; title: string}[] = []
  /**
   * 面包屑上次渲染用的签名。初值 `undefined` 而非空串：`viewPath` 为空时签名也是空串，
   * 一撞就会把「第一次该画那句『还没落到任何一层』」当成「内容没变」跳过。
   */
  let lastPathSignature: string | undefined

  let archiveChildren: BookmarkNode[] = []
  /** 当前展开状态下**可见的行**，扁平成一个数组（虚拟滚动以它为单位，见 `flattenArchive`）。 */
  let archiveRows: ArchiveRow[] = []

  /**
   * 行内展开的文件夹 id（Finder 那样就地推开，与「进入」是两件事）。
   * **不落盘**；换层（`navigateTo`）清空，刷新**不清**。
   */
  const expandedIds = new Set<string>()

  /**
   * 下次刷新时要展开的文件夹（刚存下的分组）。
   * 不在这里当场展开：新节点的 `parentById` 要等 `applyArchive` 重建索引后才知道，而祖先链得靠它。
   */
  let pendingExpandIds: string[] = []
  /** 下一次刷新后要滚进视野的那一行。新建的东西会落在末尾，不滚过去就看不见。 */
  let pendingScrollId: string | undefined

  /**
   * 已载入节点索引：当前层 + 它下面**所有后代**。
   *
   * 能建全量索引是因为 `getSubTree()` 本来就递归读了整棵子树 → 展开是纯渲染状态，零 IPC。
   * 必须有的是因为展开后行不再只属于当前层，而这些动作只认 id：改名 / 删除 / 打开 / 转换记号 /
   * 弹窗改书签 / 勾选框三态回填。以前它们在 `archiveChildren` 里找，有后代之后那种写法找不到。
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

  /** 视口上下各多渲染几行，滚动时不会看到正在补的空行。 */
  const ARCHIVE_OVERSCAN = 10

  /**
   * 行高。**从真实元素上量**，不写死 38px——那个数由 `--row-inner` 与 `--item-pad-y` 算出，
   * CSS 变量一改，写死的虚拟滚动就错位，而且错得安静（滚动条长度不对、滚着滚着跳）。
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
   * 把「画出来会受什么影响」的三件事读一次，交给纯函数去拼 HTML（见 `archiveMarkup.ts`）。
   * `canEdit` 与 `canWrite()` 是同一个判据：书签树的根及其子级都不能改名 / 删除。
   */
  function markupContext(): MarkupContext {
    return {selectable, canEdit: canWrite(), renamingId: renaming?.id, pendingDeleteId}
  }

  /**
   * 只渲染视口那几十行，上下用两个**撑高的占位行**维持滚动条。
   * 行高定值（都写 `--row-height`，扁平之后连「展开块」这种不等高的东西也没了）
   * → 第 i 行的位置就是 `i * rowHeight`，不必逐行测量。
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
    /*
     * 高亮框**一段一段地拼**，不摆绝对定位的框。
     *
     * 「在框里」只看一个布尔量：自己或某祖先被选中（`pickOwnerOf` 沿父链找）。两个后果正是要的：
     * ① 选中的文件夹展开 → 子行全在框里 → **一个框包住整个文件夹**；
     * ② 同一个文件夹里再单点一条 → 它本就在框里 → **不会多出嵌套的框**。
     * 段的首尾靠**比邻居**判（`archiveRows` 里有全部可见行，邻居在视口外也算得出）
     * → 相邻两条选中连成一段而非各画一个框。
     *
     * 虚拟滚动下比「一个框」简单：不管视口裁剪，渲染哪几行就画哪几行的边。
     */
    const top = new Set(pickedTopLevel())
    const boxCache = new Map<number, boolean>()
    const inBoxAt = (index: number): boolean => {
      if (index < 0 || index >= archiveRows.length) return false
      const hit = boxCache.get(index)
      if (hit !== undefined) return hit
      const row = archiveRows[index]
      const value = row !== undefined && pickOwnerOf(row, top, parentById) !== undefined
      boxCache.set(index, value)
      return value
    }
    for (let index = first; index < last; index++) {
      const row = archiveRows[index]
      if (!row) break
      const pickCls = inBoxAt(index)
        ? ` is-picked${inBoxAt(index - 1) ? '' : ' is-picked-start'}${inBoxAt(index + 1) ? '' : ' is-picked-end'}`
        : ''
      parts.push(archiveRowMarkup(row, markupContext(), pickCls))
    }
    const rest = total - last * height
    if (rest > 0) parts.push(`<li class="vpad" style="height:${rest}px"></li>`)

    archiveList.innerHTML = parts.join('')
    syncArchiveStates()
  }

  /**
   * 把某一行滚进视野（新建 / 改名的那行可能在视口外，`focusRenameInput()` 就抓不到输入框）。
   *
   * **两步：先按行高估一次，渲染出来再量真实位置修正。** 只靠估算不够——列表上面压着一条**吸顶**的
   * 面包屑（`.box__top`），它占着滚动内容的一段高度、滚动时又盖在内容上，加上取整会差几个像素
   * 甚至**一整行**（用户看到的就是「新建的东西没滚到」）。量一次真实元素就没有这些假设。
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
   * 滚动时重画窗口，`requestAnimationFrame` 合并同一帧的多次 scroll。
   *
   * **正在改名时不重画**：输入框会被换掉，`focusout` 会把「元素被移除」当成「用户点了别处」而提交改名
   * ——打字打到一半被提交是最糟的结果。改名期间本来也不该滚动列表。
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
   * 这一栏要不要显示勾选框（见 `ArchivePane.setSelectable`）。
   *
   * 窗口档下的右栏要：勾选驱动「打开 (N)」。两栏都是收藏夹时不要。
   */
  let selectable = true

  /**
   * 切换勾选框的显示，并当场重画。
   *
   * **不重读书签树**：这一档只影响列两行的长相，数据早就在手上。
   * 全选框那一行也收起，只剩右端那几枚按钮。
   *
   * 它同时也是**多选的开关**：没有勾选框的那一档用 Ctrl / Shift 点选。
   * 两套不能共存（同一行上两个「选中」会让「选了几条」有两种说法）。
   */
  function setSelectable(enabled: boolean): void {
    if (selectable === enabled) return
    selectable = enabled
    archiveSelectAll.input.closest('label')?.toggleAttribute('hidden', !enabled)
    archiveList.classList.toggle('is-picking', !enabled)
    clearPick()
    renderArchive()
  }

  /**
   * 被点选过的条目（**多选**，只在没有勾选框的那一档用）。
   *
   * 存「用户点过的 id」，不存「画出来的那些」——选中文件夹的子项不必再记一份（靠父链归属）。
   * 所以这是**原样的选择**，用之前先过 `topLevelPicked()`，否则同一个文件夹会被搬两次。
   */
  const pickedIds = new Set<string>()
  /**
   * Shift 范围选择的起点（上次不带修饰键点击的那一行）。
   * Shift 点击**不更新它** → 连按几次可反复调范围，不会每次以新结果为新起点（资源管理器的惯例）。
   */
  let pickAnchor: string | undefined

  /** 现在能不能点选（没有勾选框的那一档）。 */
  function picking(): boolean {
    return !selectable
  }

  function clearPick(): void {
    pickedIds.clear()
    pickAnchor = undefined
  }

  /**
   * 把选择**规约成顶层项**（`archivePick.ts` 的纯函数，这里只是补上本实例的索引）。
   * 绘制（否则嵌套框一个套一个）与拖拽（否则同一棵子树搬两次）都要它。
   */
  function pickedTopLevel(): string[] {
    return topLevelPicked(pickedIds, parentById)
  }

  /**
   * Shift 点击：把起点到这一行之间的**可见行**全选上（按**可见顺序**而非层级）。
   * 起点或终点找不到时退化成「只选终点那一条」。
   */
  function extendPickTo(id: string): void {
    pickedIds.clear()
    for (const picked of rangeBetween(archiveRows, pickAnchor, id)) pickedIds.add(picked)
  }

  /**
   * 点一行：**Ctrl / Cmd 切换、Shift 扩范围**，**普通点击不改选择**。
   *
   * 普通点击什么都不做是有意的：这一档没有勾选框，「只选这一条」会**随手点一下就把刚选好的一批清掉**。
   * 但它**仍然挪 Shift 起点**（先随手点一下再 Shift 点另一头是很自然的用法）。
   *
   * 返回 true = 这次点击已处理完；落在行内按钮 / 输入框上时返回 false（各有自己的语义）。
   */
  function handlePickClick(event: MouseEvent): boolean {
    if (!picking()) return false
    const target = event.target as HTMLElement
    if (target.closest('input, button, a, [data-rename-input]')) return false
    const row = target.closest<HTMLElement>('[data-node-id]')
    const id = row && archiveList.contains(row) ? row.dataset.nodeId : undefined

    // 点在空白处：取消选择（不然那几条会一直在下面亮着，而用户以为已经点掉了）。
    if (id === undefined) {
      if (pickedIds.size === 0) return false
      clearPick()
      renderArchive()
      return true
    }

    if (event.shiftKey) {
      extendPickTo(id)
      // Shift 不挪起点（见 `pickAnchor`）。
      renderArchive()
      return true
    }
    if (event.ctrlKey || event.metaKey) {
      if (pickedIds.has(id)) pickedIds.delete(id)
      else pickedIds.add(id)
      pickAnchor = id
      renderArchive()
      return true
    }
    // 普通点击：不改选择，也不重绘——只把起点挪过来（上面那两条依赖它）。
    pickAnchor = id
    return true
  }

  /**
   * 拖动开始时把整段选中项都标成「正在拖」（不然只看得到鼠标下那一条在变淡）。
   *
   * 面板在 `dragstart` 里调 `dragIdsOf()`，它顺手调这里。
   */
  function markPickedDragging(): void {
    for (const row of archiveList.querySelectorAll<HTMLElement>('[data-node-id]')) {
      const id = row.dataset.nodeId
      if (id !== undefined && pickedIds.has(id)) row.classList.add('is-dragging')
    }
  }

  /**
   * 当前展示的是不是书签树的**根**。
   *
   * 根是唯一没有父的节点 → 「路径只有一层」就是「是不是根」（不必把 id `0` 这个魔法值写进业务代码）。
   * 它是两个结论的**同一依据**，只判一次：Chrome 不接受在根下面建东西（→ `canWrite()`）；
   * 根的子级是固定文件夹，改名 / 删除会被拒（→ 行内不给那两个按钮）。
   */
  function atTreeRoot(): boolean {
    return viewPath.length <= 1
  }

  /** 能不能往当前这一层写（根只是三个内置目录的容器，Chrome 不接受在它下面建东西）。 */
  function canWrite(): boolean {
    return !atTreeRoot()
  }

  /**
   * 面包屑。**除当前层都能点**（当前层做成链接只是噪声）；可跳到收藏**之上**的层——右栏是自由的浏览器。
   * 用按钮不用 `<a>`：它不换页，只换右栏内容。不可点的当前层也套 `.path__label`（与链接**同一个盒子**），
   * 否则进子文件夹时整排会左右抽动一下。
   */
  function renderArchivePath(): void {
    // 面包屑也是「外部数据驱动 + 频繁重跑」→ 签名没变就只更新下面那行说明，
    // 否则那一排按钮每次被换成新元素，悬停 / 焦点当场丢掉，用户看到「字没变但闪一下」。
    const signature = JSON.stringify(viewPath.map((node) => [node.id, node.title]))
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

    // 根上写入入口都是灰的，说清原因与退路（否则看着像「到了这里啥也干不了」）。
    archiveNote.hidden = !viewFolderId || canWrite()
    archiveNote.textContent = '这里是书签树的根，Chrome 不允许直接在它下面放东西。双击下面任意一个文件夹进去即可。'
  }

  function renderArchive(): void {
    renderArchivePath()
    // 「取消选中」只在真选中了东西时露面。放在**开头**：这个函数有好几条提前 return
    //（空文件夹、书签树根），每一条都得把它算一遍，否则从「选中了一批」的层走到空层时它还会留着。
    clearPickButton.classList.toggle('is-slot-hidden', pickedIds.size === 0)
    // 胸章数「这一层里能干活的东西」：子文件夹可以进去，书签可以打开。分隔线两样都不是。
    // **这一栏可以没有胸章**（左栏那个实例）：它的两档共用一枚，而那枚归面板管（见 `count()`）。
    if (archiveCount) archiveCount.textContent = String(countValue(archiveChildren))

    if (!viewFolderId) {
      archiveList.innerHTML =
        '<li class="empty">读不到书签栏，这一栏无法显示内容。</li>'
      // 早退分支**必须**也调同步：全选框的文案与三态在它里面算，漏掉就停在上一次的层。
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

    archiveRows = flattenArchive(archiveChildren, viewFolderId, expandedIds)
    // 编辑中的那一行、或刚存下的文件夹，都可能不在视口里（新建的落在末尾）→ 先滚进来再渲染窗口，
    // 否则 `focusRenameInput()` 抓不到输入框，用户也看不到自己刚建的东西。
    if (renaming) scrollRowIntoView(renaming.id)
    if (pendingScrollId) {
      scrollRowIntoView(pendingScrollId)
      pendingScrollId = undefined
    }
    renderArchiveWindow()
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

    const ids = archiveBookmarkIds(archiveChildren)
    archiveSelectAll.update(ids.filter((id) => !archiveExcluded.has(id)).length, ids.length)
    updateButtons()
  }

  const NAVIGATION_GUARD_MS = 350

  /** 跳到某一层（双击子文件夹、点「进入」、点面包屑都走这里）。 */
  async function navigateTo(folderId: string): Promise<void> {
    if (flags.busy || !folderId || folderId === viewFolderId) return
    const now = Date.now()
    if (now - lastNavigationAt < NAVIGATION_GUARD_MS) return
    lastNavigationAt = now

    // 换层时把行内编辑、展开状态与多选都丢掉：那些行已经不在眼前了。
    // 展开状态不跟着走是为了不让它越攒越多（一个层的展开与否只对那一层的浏览有意义）。
    renaming = undefined
    pendingDeleteId = undefined
    expandedIds.clear()
    clearPick()
    viewFolderId = folderId
    // 从头看：上一次停在中途的位置对新的一层没有意义。
    archiveBox.scrollTop = 0
    await refresh()
  }

  /**
   * 重新决定右栏落在哪一层。
   * 顺序：第一个**可用**的收藏 → 书签栏 → 空。收藏里可能已删掉几个，所以不能只看第一个；
   * 一个收藏都没有时落到书签栏（那是唯一「总是有意义」的层）；连书签栏都读不出来才真的空着，
   * 此时清空 `viewFolderId` 让右栏去渲染空态。
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
    // 多选也剔一遍：被搬走 / 被删掉的那几条不该继续亮着（它们已经不在这里了）。
    for (const id of [...pickedIds]) if (!nodeIndex.has(id)) pickedIds.delete(id)

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

    const alive = new Set(archiveBookmarkIds(archiveChildren))
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
    if (spot && !canDropTo(payload, dropTargetId(spot), parentById)) {
      // 兜底：正常路径上 `dragover` 已把 dropEffect 置成 none、drop 不会派发，
      // 但万一走到这里绝不能报「已调整收藏夹顺序」——那是假话，实际什么都没做。
      setStatus(status, '不能把文件夹挪进它自己里面。', 'error')
      return
    }

    // **不置灰按钮**：`busy` 只是防重入，而这一步几乎是瞬时的。一旦在这里调 `updateButtons()`，
    // 中间那排按钮会先变灰再恢复 → 用户看到「按钮闪一下」。真花时间的操作才该置灰。
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
   * 就地展开 / 收起一个文件夹（点左侧那枚方块）。
   *
   * 不 `await`、也不重读书签树：`getSubTree()` 已把整棵子树读进来了，子级就在 `folder.children` 里。
   * 重绘不会丢展开状态（它在模块状态里，不在 DOM 里），并会走 `syncArchiveStates()` 回填新出现的勾选框。
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
   * 这棵子树里**可以展开**（有子级）的文件夹数量。空文件夹不算：展开它只会多出一行「这个文件夹是空的」，
   * 而那一行的副文案已经把同一件事说完了。
   */
  function expandableCount(): number {
    let count = 0
    for (const node of nodeIndex.values()) {
      if (!node.url && (node.children?.length ?? 0) > 0) count++
    }
    return count
  }

  /**
   * 全部展开 / 全部折叠（一个按钮两档）。不是「树视图」，是给已展开的那几层加一个「一次全看完」的
   * 手势（全展开后可以用浏览器自己的页内查找 Ctrl+F）。
   *
   * **有展开的就全部收起，否则全部展开**（按钮上的字已说明下一档）。判据看 `expandedIds` 而不是
   * 「当前层有没有可见的已展开项」：两者总是一致，但前者不用再走一遍 DOM。
   *
   * 必须配**虚拟滚动**：全展开是 11003 行 / 12MB HTML，没虚拟化时一次 `innerHTML` 就是 983ms 卡顿
   * + 2402ms 布局。展开本身是纯内存（约 20ms），贵的是渲染。
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

  /** 只按 id 取标题（调用方只会传文件夹 id：给新建分组起名）。 */
  function archiveFolderTitle(id: string): string | undefined {
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

    // 剩下的情况就是「点在行上」：
    //   有勾选框那一档（窗口档的右栏）—— 替用户点那个勾选框；
    //   没有勾选框那一档（两栏都是收藏夹）—— 多选（Ctrl / Shift / 单击）。
    if (handlePickClick(event)) return
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

    // 只服务文件夹与分隔线（书签的改名走模态弹窗）。文件夹名不能为空 → 清洗后退回原名；
    // 分隔线允许留空（就成了一条通线）。
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
    // 只立 `busy`（防重入）而**不置灰按钮**：删一条几乎是瞬时的，置灰 → 恢复会让一排按钮闪一下。
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

  // 「打开书签管理器」开的就是当前展示的这一层：给 `?id=` 一个数字 id 就能直接落在那一层
  //（为什么用数字 id、以及那个上游 bug 见 `AGENTS.md` 第 29 条）。
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
    if (!canWrite() || flags.busy) return
    flags.busy = true
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

  // 两种记号各一个按钮，**不合并成一个再让用户去改**（外观完全不同，建完再转一次是多余的一步）。
  // 建完直接进改名状态：它的全部意义常常就在那个标题上。
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
  // 与「点空白处」同一条路（`clearPick` + 重绘），只是给了一个看得见的入口——
  // 选中之后那一批会亮着，而「怎么把它们取消掉」不该只有「点空白」一个暗示。
  clearPickButton.addEventListener('click', () => {
    clearPick()
    renderArchive()
  })

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

  /** 这一条现在挂在哪一层（见 `ArchivePane.parentOf`）。 */
  function parentOf(nodeId: string): string | undefined {
    return parentById.get(nodeId)
  }

  /**
   * 拖动这一行时应该带走哪些 id。
   *
   * 返回 `undefined` 表示「就拖这一行」（走单条那条路）；返回一份 id 列表表示这是一次**多选拖动**。
   * 条件是：被拖的行在选中集合里，而选中集合规约之后**不止一条**（只有一条时与单拖等价，
   * 没必要让载荷变成一个数组的形式）。
   */
  function dragIdsOf(row: HTMLElement): string[] | undefined {
    const id = row.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
    if (id === undefined || !pickedIds.has(id)) return undefined
    const ids = pickedTopLevel()
    if (ids.length < 2) return undefined
    // 整段一起变淡（拖动时才看得出这一批有哪几条）。
    markPickedDragging()
    return ids
  }

  /**
   * 本栏现在选中的条目（规约过的顶层项）。
   *
   * 面板用它把「这一批」写进拖拽载荷（`{kind: 'selection', ids}`）。
   */
  function selectionIds(): string[] {
    return topLevelPicked(pickedIds, parentById)
  }

  return {
    list: archiveList,
    actionsHost,
    openRootButton,
    isWritable: canWrite,
    parentOf,
    dragIdsOf,
    selectionIds,
    clearPick,
    currentFolderId: () => viewFolderId,
    currentFolderTitle: () => viewPath.at(-1)?.title ?? '',
    keptCount: () => keptCount(archiveBookmarkIds(archiveChildren), archiveExcluded),
    count: () => countValue(archiveChildren),
    setSelectable,
    excluded: () => archiveExcluded,
    reload: refresh,
    navigateTo,
    updateButtons,
    handleChange,
    dropSpot: archiveDropSpot,
    canDropAt: (payload, targetId) => canDropTo(payload, targetId, parentById),
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
