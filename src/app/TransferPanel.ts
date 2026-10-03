import {
  createBookmark,
  createFolder,
  getNodePath,
  getSubTree,
  isRealBookmark,
  realBookmarks,
  removeSubTree,
  renameNode
} from '../shared/bookmarks'
import {
  planWindowChildren,
  snapshotCurrentWindow,
  writeChildren,
  type WindowChild
} from '../shared/capture'
import {sanitizeFolderName} from '../shared/naming'
import {openFolderViewers, restoreFolder} from '../shared/restore'
import {loadSettings} from '../shared/settings'
import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {BookmarkNode, RestoreOptions, TabSnapshot} from '../shared/types'
import {hostnameOf, isSeparatorUrl, separatorTitle} from '../shared/urls'
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

/** Chrome 本地 favicon 缓存端点：读缓存、不联网。 */
const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

/**
 * 内建拖拽载荷的类型名。
 *
 * 用它而不是 `text/plain` 是为了区分「本项目内部的拖动」与「从网页拖来的链接」：
 * 后者只带 `text/uri-list`，处理方式不同（按网址存成书签，而不是按键找书签）。
 */
const DRAG_TYPE = 'application/x-tabfurl'

/** 拖动来源：左栏的标签/分组，或右栏的一条书签/文件夹。 */
type DragPayload =
  | {kind: 'tab'; tabId: number}
  | {kind: 'group'; index: number}
  | {kind: 'bookmark'; id: string}
  | {kind: 'folder'; id: string}

type RestoreKind = 'newWindow' | 'currentWindow' | 'onlyTabs'

/**
 * 「已固定」标记。与文件夹图标同理，不用 emoji：它在灰字里是个突如其来的彩色块。
 */
const PIN_ICON = `
  <svg class="icon icon--xs item__pin" viewBox="0 0 24 24" role="img" aria-label="已固定">
    <path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3Z"
          fill="currentColor" />
  </svg>
`

/**
 * 文件夹图标。与阅读页的子文件夹卡片用**同一个** `.folder-tile`（见 base.css）。
 *
 * 右栏里它不只是装饰：两种行都带勾选框，而勾选框左边的位置以前是空的，文件夹行看起来就与书签行一样。
 * 放上它之后，「这一行可以进去」与「这一行是个页面」在左侧一眼可分。
 */
const FOLDER_ICON = `
  <svg class="folder-tile__icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h2.6a1 1 0 0 1 .8.4l.9 1.2h5.2A1.5 1.5 0 0 1 14.25 6.1v5.4A1.5 1.5 0 0 1 12.75 13H3.25A1.5 1.5 0 0 1 1.75 11.5Z"
          fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
  </svg>
`

/**
 * 「在新窗口打开」的加号。SVG 而不是 `＋` 字形：全角加号在各字体里的字身与基线都不同，
 * 摆在旁边的 `→` / `←` 中间会明显错位（与文件夹图标、刷新图标同一个理由）。
 */
const PLUS_ICON = `
  <svg class="move__icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor"
          stroke-width="1.9" stroke-linecap="round" />
  </svg>
`

const TEMPLATE = `
  <div class="split">
    <section class="col">
      <header class="col__head">
        <h2 class="col__title">当前窗口 <span class="badge" id="window-count">0</span></h2>
      </header>
      <div class="row row--compact" id="window-all-host"></div>
      <ul class="box" id="window-list" data-drop-pane="window"></ul>
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
        <span class="move__icon">${PLUS_ICON}</span>
        <span id="open-window-label">新窗口</span>
      </button>
      <button type="button" class="btn btn--ghost btn--sm" id="undo-btn" hidden>撤销上次保存</button>
    </div>

    <section class="col">
      <header class="col__head">
        <h2 class="col__title">存档 <span class="badge" id="archive-count">0</span></h2>
        <button type="button" class="btn btn--ghost btn--sm col__head-action"
                id="archive-up-btn" disabled>↑ 上一层</button>
      </header>
      <nav class="path" id="archive-path" aria-label="当前所在的存档文件夹"></nav>
      <div class="row row--compact">
        <button type="button" class="btn btn--ghost btn--sm" id="new-folder-btn">＋ 新建文件夹</button>
        <button type="button" class="btn btn--ghost btn--sm" id="open-root-btn" hidden>打开阅读页</button>
      </div>
      <div class="row row--compact" id="archive-all-host"></div>
      <ul class="box" id="archive-list" data-drop-pane="archive"></ul>
    </section>
  </div>

  <div class="row">
    <button type="button" class="btn btn--ghost btn--sm" id="open-tabs-btn" disabled>只开标签页（不建分组）</button>
    <span class="status" id="status" hidden></span>
  </div>
`

/**
 * 保存 / 打开两栏视图（替代原来的「保存」「存档」两个 Tab）。
 *
 * 两栏装的是**同一个东西的两侧**：左边是活会话（当前窗口，标签还住在浏览器里），
 * 右边是已落盘的（存档根下的分组与散装书签）。两者同形——都是有序的「分组 | 标签」序列——所以：
 *
 * - 「存过去」与「打开」会把左栏或右栏**当前勾选**的内容整体送过去；
 * - 拖拽是同一件事的**精确版**：拖一条标签就只存这一条，落在哪个文件夹行上就进哪个文件夹；
 * - 没有会话层：每次保存都是往存档根（或某个分组文件夹）里追加，不做去重，同名文件夹也不合并。
 */
export function createTransferPanel(events: AppEvents): Panel {
  const element = createPanelElement('transfer')
  element.innerHTML = TEMPLATE

  const windowList = q<HTMLUListElement>(element, '#window-list')
  const archiveList = q<HTMLUListElement>(element, '#archive-list')
  const windowCount = q<HTMLSpanElement>(element, '#window-count')
  const archiveCount = q<HTMLSpanElement>(element, '#archive-count')
  const archivePath = q<HTMLElement>(element, '#archive-path')
  const saveButton = q<HTMLButtonElement>(element, '#save-btn')
  const saveLabel = q<HTMLSpanElement>(element, '#save-label')
  const openButton = q<HTMLButtonElement>(element, '#open-btn')
  const openLabel = q<HTMLSpanElement>(element, '#open-label')
  const openWindowButton = q<HTMLButtonElement>(element, '#open-window-btn')
  const openWindowLabel = q<HTMLSpanElement>(element, '#open-window-label')
  const undoButton = q<HTMLButtonElement>(element, '#undo-btn')
  const newFolderButton = q<HTMLButtonElement>(element, '#new-folder-btn')
  const upButton = q<HTMLButtonElement>(element, '#archive-up-btn')
  const openRootButton = q<HTMLButtonElement>(element, '#open-root-btn')
  const openTabsButton = q<HTMLButtonElement>(element, '#open-tabs-btn')
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

  const archiveSelectAll = createSelectAll(q<HTMLDivElement>(element, '#archive-all-host'), {
    describe: (kept, total) => {
      if (total === 0) return '存档里还没有可打开的标签页'
      return kept === 0
        ? `尚未勾选（存档里共 ${total} 枚标签页），勾选后才能打开`
        : `已选 ${kept} / ${total} 枚标签页`
    },
    onChange: (wantAll) => {
      for (const id of archiveBookmarkIds()) {
        if (wantAll) archiveExcluded.delete(id)
        else archiveExcluded.add(id)
      }
      syncArchiveStates()
    }
  })

  let archiveRootId = ''
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
  let windowChildren: WindowChild[] = []
  let archiveChildren: BookmarkNode[] = []
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

  function tabRowMarkup(tab: TabSnapshot): string {
    const host = hostnameOf(tab.url) ?? tab.url
    return `
      <li class="item leaf" draggable="true" data-drag-tab="${tab.tabId}">
        <input type="checkbox" data-window-tab="${tab.tabId}" />
        ${faviconMarkup(tab.url, FAVICON_BASE)}
        <span class="item__main">
          <span class="item__title">${escapeHtml(tab.title || tab.url)}${tab.pinned ? PIN_ICON : ''}</span>
          <span class="item__meta">${escapeHtml(host)}</span>
        </span>
      </li>
    `
  }

  function renderWindow(): void {
    windowCount.textContent = String(allWindowTabs().length)

    if (windowChildren.length === 0) {
      windowList.innerHTML = '<li class="empty">当前窗口没有可保存的标签页。</li>'
      updateButtons()
      return
    }

    windowList.innerHTML = windowChildren
      .map((child, index) =>
        child.kind === 'tab'
          ? tabRowMarkup(child.tab)
          : `
          <li class="group">
            <div class="item group__head" draggable="true" data-drag-group="${index}">
              <input type="checkbox" data-window-group="${index}" />
              <span class="item__title">${escapeHtml(child.name)}</span>
              <span class="item__meta">${child.tabs.length} 个标签</span>
            </div>
            <ul class="kids">${child.tabs.map(tabRowMarkup).join('')}</ul>
          </li>
        `
      )
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

  /** 一条书签行。分隔线占位书签也画成一条横线，且没有勾选框。 */
  function archiveBookmarkRow(bookmark: BookmarkNode): string {
    if (isSeparatorUrl(bookmark.url)) {
      const title = separatorTitle(bookmark.title)
      return title
        ? `<li class="divider"><span>${escapeHtml(title)}</span></li>`
        : '<li class="divider divider--plain"></li>'
    }

    const url = bookmark.url ?? ''
    const host = hostnameOf(url) ?? url
    return `
      <li class="item leaf" draggable="true"
          data-drag-bookmark="${escapeHtml(bookmark.id)}"
          data-bookmark-url="${escapeHtml(url)}">
        <input type="checkbox" data-archive-item="${escapeHtml(bookmark.id)}" />
        ${faviconMarkup(url, FAVICON_BASE)}
        <span class="item__main">
          <span class="item__title">${escapeHtml(bookmark.title.trim() || host)}</span>
          <span class="item__meta">${escapeHtml(host)}</span>
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
      ? `<input type="text" class="input input--rename" data-rename-input="${escapeHtml(folder.id)}"
                value="${escapeHtml(folder.title)}" aria-label="重命名文件夹" />`
      : `<span class="item__title">${escapeHtml(folder.title)}</span>`

    const actions = isRenaming
      ? '<span class="item__meta">回车保存，Esc 取消</span>'
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
      <li class="group" data-drop-folder="${escapeHtml(folder.id)}"
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

  /** 存档根在当前路径里的下标：它及它下面那些层可以跳，上面的只作上下文。 */
  function rootIndexInPath(): number {
    return viewPath.findIndex((node) => node.id === archiveRootId)
  }

  /**
   * 上一层的 id；已经在存档根上（或路径取不到）时返回 undefined。
   *
   * 不允许退回存档根之上：「存过去」写的是当前层，退到存档外面去写入就跑到用户指定的范围之外了。
   */
  function parentFolderId(): string | undefined {
    const rootIndex = rootIndexInPath()
    if (rootIndex < 0) return undefined
    return viewPath.length - 2 >= rootIndex ? viewPath[viewPath.length - 2].id : undefined
  }

  function renderArchivePath(): void {
    const rootIndex = rootIndexInPath()
    archivePath.innerHTML = viewPath.length === 0
      ? '<span class="muted">尚未指定存档位置</span>'
      : viewPath
          .map((node, index) => {
            const label = escapeHtml(node.title)
            // 当前层是这一页自身，做成链接只是噪声；存档根之上不属于存档范围，不给跳。
            if (index < rootIndex || index === viewPath.length - 1) return `<span>${label}</span>`
            return `<button type="button" class="path__link"
                            data-goto-folder="${escapeHtml(node.id)}">${label}</button>`
          })
          .join('<span class="path__sep">/</span>')
  }

  function renderArchive(): void {
    renderArchivePath()
    // 胸章数的是「这一层里能干活的东西」：子文件夹可以进去，书签可以打开。分隔线两样都不是。
    archiveCount.textContent = String(
      archiveChildren.filter((child) => !child.url).length + realBookmarks(archiveChildren).length
    )

    if (!viewFolderId) {
      archiveList.innerHTML =
        '<li class="empty">还没有指定存档位置，请在上方选一个书签栏里的文件夹。</li>'
      updateButtons()
      return
    }

    if (archiveChildren.length === 0) {
      archiveList.innerHTML =
        '<li class="empty">这个文件夹还是空的。把左侧的标签拖过来即可存下。</li>'
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
   * 存档里全部可打开的书签 id（含散装与分组内的）。
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

    saveLabel.textContent = `存过去（${keptTabs}）`
    openLabel.textContent = `打开（${keptBookmarks}）`
    openWindowLabel.textContent = `新窗口（${keptBookmarks}）`
    // 落点写在按钮自己的提示里：写入目标是「当前展示的这一层」，而那一层远在右栏顶部的路径里，
    // 中间的按钮与它隔了一整栏。悬停能确认「到底存进哪个文件夹」，不必来回对路径。
    saveButton.title = viewFolderId
      ? `存进「${viewPath.at(-1)?.title ?? ''}」`
      : '还没有指定存档位置'
    saveButton.disabled = busy || keptTabs === 0 || !viewFolderId
    openButton.disabled = busy || keptBookmarks === 0
    openWindowButton.disabled = busy || keptBookmarks === 0
    openTabsButton.disabled = busy || keptBookmarks === 0
    undoButton.hidden = !lastWrite
    undoButton.disabled = busy
    newFolderButton.disabled = busy || !viewFolderId
    upButton.disabled = busy || !parentFolderId()
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
    archiveRootId = (await loadSettings()).archiveRootId
    windowChildren = planWindowChildren(await snapshotCurrentWindow())

    // 标签被关掉之后它的 tabId 不会再出现；留着只会让集合越涨越大。
    const aliveTabs = new Set(allWindowTabs().map((tab) => tab.tabId))
    for (const tabId of [...windowExcluded]) if (!aliveTabs.has(tabId)) windowExcluded.delete(tabId)

    // 视图落点：能留在原地就留在原地——用户在浏览存档，不该因为一次刷新被弹回根。
    // 但存档根换了（或那一层被删了）就得回根，否则「存过去」会写到一个已经不是存档的位置。
    viewPath = viewFolderId ? await getNodePath(viewFolderId) : []
    if (!archiveRootId || !viewPath.some((node) => node.id === archiveRootId)) {
      viewFolderId = archiveRootId
      viewPath = archiveRootId ? await getNodePath(archiveRootId) : []
    }

    const folder = viewFolderId ? await getSubTree(viewFolderId) : undefined
    archiveChildren = folder?.children ?? []

    // 打开侧默认一个都不勾：没见过的书签一律算排除。
    const alive = new Set(archiveBookmarkIds())
    for (const id of alive) {
      if (!knownBookmarks.has(id)) {
        knownBookmarks.add(id)
        archiveExcluded.add(id)
      }
    }
    for (const id of [...knownBookmarks]) if (!alive.has(id)) knownBookmarks.delete(id)
    for (const id of [...archiveExcluded]) if (!alive.has(id)) archiveExcluded.delete(id)

    renderWindow()
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
   */
  async function openSelection(kind: RestoreKind): Promise<void> {
    if (busy || !viewFolderId) return
    busy = true
    updateButtons()
    setStatus(status, '正在打开…', 'ok')

    const options: RestoreOptions =
      kind === 'onlyTabs'
        ? {target: 'newWindow', groupTabs: false, excludeBookmarkIds: archiveExcluded}
        : {target: kind, excludeBookmarkIds: archiveExcluded}

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
    return undefined
  }

  function draggedElement(event: DragEvent): HTMLElement | undefined {
    return (event.target as HTMLElement).closest<HTMLElement>(
      '[data-drag-tab], [data-drag-group], [data-drag-bookmark], [data-drag-folder]'
    ) ?? undefined
  }

  function clearDropMarks(): void {
    for (const marked of element.querySelectorAll('.is-drop-active, .is-dragging')) {
      marked.classList.remove('is-drop-active', 'is-dragging')
    }
  }

  element.addEventListener('dragstart', (event) => {
    const dragged = draggedElement(event)
    if (!dragged || !event.dataTransfer) return
    const payload = payloadOf(dragged)
    if (!payload) return

    dragging = payload
    event.dataTransfer.effectAllowed = 'copy'
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

  /** 拖到哪一格上：文件夹行优先，否则落到整块面板（= 存档根）。 */
  function dropFolderOf(event: DragEvent): string | undefined {
    return (event.target as HTMLElement).closest<HTMLElement>('[data-drop-folder]')?.dataset
      .dropFolder
  }

  element.addEventListener('dragover', (event) => {
    const pane = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-pane]')
    if (!pane || !event.dataTransfer) return

    // 收不收这次拖动，只看「拖的是什么」与「落在哪一栏」：
    //   右栏（存档）：只收左栏的标签/分组，以及从外部拖来的网址；
    //   左栏（当前窗口）：只收右栏的书签/文件夹——把它当成「打开」的落点。
    const toArchive = pane.dataset.dropPane === 'archive'
    const internalToArchive = dragging?.kind === 'tab' || dragging?.kind === 'group'
    const internalToWindow = dragging?.kind === 'bookmark' || dragging?.kind === 'folder'
    const externalUrls = Array.from(event.dataTransfer.types).includes('text/uri-list')
    if (dragging ? (toArchive ? !internalToArchive : !internalToWindow) : !(toArchive && externalUrls)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'

    clearDropMarks()
    const folder = dropFolderOf(event)
    const marked = folder && toArchive
      ? archiveList.querySelector(`[data-drop-folder="${folder}"]`)
      : pane
    marked?.classList.add('is-drop-active')
  })

  element.addEventListener('drop', async (event) => {
    const pane = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-pane]')
    if (!pane || !event.dataTransfer) return
    event.preventDefault()

    const payload = dragging
    const raw = event.dataTransfer.getData(DRAG_TYPE)
    const urls = event.dataTransfer
      .getData('text/uri-list')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))

    dragging = undefined
    clearDropMarks()

    if (pane.dataset.dropPane === 'archive') {
      // 没落在某个文件夹行上 = 落在当前展示的这一层里（而不是无条件落在存档根）。
      const parentId = dropFolderOf(event) ?? viewFolderId
      if (!parentId) return
      const children = payload ? childrenFor(payload) : []
      if (children.length > 0) await writeInto(parentId, children)
      else if (urls.length > 0) await saveUrls(urls, parentId)
      return
    }

    // 落到左栏 = 打开。
    if (payload?.kind === 'bookmark') {
      await openBookmark(payload.id)
      return
    }
    if (payload?.kind === 'folder') {
      await restoreFolder(payload.id, {target: 'currentWindow', groupTabs: false})
      setStatus(status, '已把该文件夹里的标签页打开。', 'ok')
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

  /** 打开一条书签（拖到左栏）。 */
  async function openBookmark(id: string): Promise<void> {
    const url = bookmarkUrl(id)
    if (!url) return
    await chrome.tabs.create({url, active: false})
    setStatus(status, '已打开 1 个标签页。', 'ok')
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
      renaming = {id: renameButton.dataset.rename, committed: false}
      pendingDeleteId = undefined
      renderArchive()
      archiveList.querySelector<HTMLInputElement>('[data-rename-input]')?.focus()
      return
    }

    const enterButton = target.closest<HTMLButtonElement>('[data-enter]')
    if (enterButton?.dataset.enter) void navigateTo(enterButton.dataset.enter)
  })

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

    const next = sanitizeFolderName(input.value, node.title)
    try {
      if (next !== node.title) await renameNode(id, next)
    } catch (error) {
      setStatus(status, `改名失败：${errorText(error)}`, 'error')
    } finally {
      renaming = undefined
      await events.archiveChanged()
    }
  }

  async function confirmDelete(id: string): Promise<void> {
    if (busy) return
    busy = true
    pendingDeleteId = undefined
    updateButtons()
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

  // 「存过去」写的是**当前展示的这一层**，不是存档根：右栏是一个可导航的浏览器，
  // 「站在哪儿就往哪儿存」才说得通。
  saveButton.addEventListener('click', () => {
    if (viewFolderId) void writeInto(viewFolderId, keptWindowChildren())
  })

  // 三个打开入口按「这一次要开到哪里」分：当前窗口 / 新窗口 / 新窗口但不建分组。
  // 它们与拖拽共用 restoreFolder，口径不会分叉。
  openButton.addEventListener('click', () => void openSelection('currentWindow'))
  openWindowButton.addEventListener('click', () => void openSelection('newWindow'))
  openTabsButton.addEventListener('click', () => void openSelection('onlyTabs'))
  undoButton.addEventListener('click', () => void undo())

  // 阅读页开的就是当前展示的这一层，这样「看这一层的全貌」与「打开这一层」是同一处。
  openRootButton.addEventListener('click', () => {
    if (viewFolderId) void openFolderViewers([viewFolderId])
  })

  upButton.addEventListener('click', () => {
    const parent = parentFolderId()
    if (parent) void navigateTo(parent)
  })

  newFolderButton.addEventListener('click', async () => {
    if (!viewFolderId || busy) return
    busy = true
    updateButtons()
    try {
      const name = await nextFolderName(viewFolderId)
      const created = await createFolder(viewFolderId, name)
      // 建完直接进入改名状态：空文件夹只有名字可改，先让用户把名字定下来。
      renaming = {id: created.id, committed: false}
      await events.archiveChanged()
      await refresh()
      archiveList.querySelector<HTMLInputElement>('[data-rename-input]')?.focus()
    } catch (error) {
      setStatus(status, `新建失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateButtons()
    }
  })

  /** 新建文件夹的默认名。这里**只**为避免同一层里出现完全相同的默认名，不是去重机制。 */
  async function nextFolderName(parentId: string): Promise<string> {
    const {children} = await getSubtreeChildren(parentId)
    const taken = children.map((child) => child.title)
    if (!taken.includes('新建文件夹')) return '新建文件夹'
    for (let n = 2; n < 1000; n++) {
      const candidate = `新建文件夹 ${n}`
      if (!taken.includes(candidate)) return candidate
    }
    return `新建文件夹 ${Date.now()}`
  }

  async function getSubtreeChildren(
    parentId: string
  ): Promise<{children: BookmarkNode[]}> {
    const node = await getSubTree(parentId)
    return {children: node?.children ?? []}
  }

  return {element, refresh}
}
