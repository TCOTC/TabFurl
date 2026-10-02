import {getSubTree, removeSubTree, renameNode} from '../shared/bookmarks'
import {sanitizeFolderName} from '../shared/naming'
import {
  openFolderViewers,
  planRestore,
  restoreFolder,
  type PlannedBookmark,
  type PlannedItem,
  type RestorePlan
} from '../shared/restore'
import {loadSettings, updateSettings} from '../shared/settings'
import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {BookmarkNode, Settings} from '../shared/types'
import {hostnameOf} from '../shared/urls'
import {
  createPanelElement,
  createSelectAll,
  errorText,
  q,
  setStatus,
  type AppEvents,
  type Panel
} from './dom'

/** Chrome 本地 favicon 缓存端点：读缓存、不联网（配合 `tileMarkup` 使用）。 */
const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

/** 一个存档会话 + 它的还原计划。计划既是勾选清单的数据源，也是还原的依据。 */
interface SessionView {
  node: BookmarkNode
  plan: RestorePlan
}

const TEMPLATE = `
  <h2 class="panel__title">存档 <span class="badge" id="archive-count">0</span></h2>
  <div class="row row--compact">
    <input type="search" class="input input--search" id="archive-search"
           placeholder="搜索存档（名称或里面的标签页）" autocomplete="off" />
    <button type="button" class="btn btn--ghost btn--sm" id="expand-all-btn">全部展开</button>
    <button type="button" class="btn btn--ghost btn--sm" id="collapse-all-btn">全部折叠</button>
    <button type="button" class="btn btn--ghost btn--sm" id="open-root-btn" hidden>打开存档根</button>
  </div>
  <div class="row row--compact" id="sessions-all-host"></div>
  <ul class="tree" id="session-list"></ul>
  <div class="row">
    <button type="button" class="btn btn--primary" id="open-window-btn" disabled>还原为窗口</button>
    <button type="button" class="btn" id="open-tabs-btn" disabled>只开标签页</button>
    <button type="button" class="btn" id="open-viewers-btn" disabled>打开阅读页</button>
  </div>
  <p class="status" id="restore-status" hidden></p>
`

/**
 * 「存档」面板：会话树 + 管理交互。
 *
 * 树的内容直接来自 `planRestore()`（与还原同一份数据），所以清单里看到几枚标签，
 * 还原时就会开几枚——不靠人工对齐两处口径。
 */
export function createArchivePanel(events: AppEvents): Panel {
  const element = createPanelElement('archive')
  element.innerHTML = TEMPLATE

  const countBadge = q<HTMLSpanElement>(element, '#archive-count')
  const searchInput = q<HTMLInputElement>(element, '#archive-search')
  const expandAllButton = q<HTMLButtonElement>(element, '#expand-all-btn')
  const collapseAllButton = q<HTMLButtonElement>(element, '#collapse-all-btn')
  const openRootButton = q<HTMLButtonElement>(element, '#open-root-btn')
  const sessionList = q<HTMLUListElement>(element, '#session-list')
  const openWindowButton = q<HTMLButtonElement>(element, '#open-window-btn')
  const openTabsButton = q<HTMLButtonElement>(element, '#open-tabs-btn')
  const openViewersButton = q<HTMLButtonElement>(element, '#open-viewers-btn')
  const status = q<HTMLParagraphElement>(element, '#restore-status')

  const selectAll = createSelectAll(q<HTMLDivElement>(element, '#sessions-all-host'), {
    describe: (kept, total) => {
      if (total === 0) return '没有可选的存档'
      if (kept === 0) return `未选中存档（共 ${total} 个）`
      const tabs = selectedBookmarkCount()
      return `已选 ${kept} / ${total} 个存档 · ${tabs} 个标签页`
    },
    onChange: (wantAll) => {
      for (const view of rendered) {
        if (wantAll) selectedSessions.add(view.node.id)
        else selectedSessions.delete(view.node.id)
      }
      render()
    }
  })

  let settings: Settings | undefined
  let archiveAvailable = false
  let busy = false

  let sessions: SessionView[] = []
  let rendered: SessionView[] = []
  const expanded = new Set<string>()
  const selectedSessions = new Set<string>()
  /** 被勾掉的书签 id（跨存档共用一个集合，书签 id 本身全局唯一）。 */
  const excludedBookmarks = new Set<string>()
  const contentInputs = new Map<string, HTMLInputElement>()
  /** 容器 id（会话或分组）→ 它包含的书签 id，用于整组勾选与计数。 */
  const containerBookmarks = new Map<string, string[]>()
  const sessionMetas = new Map<string, HTMLElement>()
  let pendingDeleteId: string | undefined
  let renaming: {id: string; committed: boolean} | undefined

  function sessionMetaText(view: SessionView): string {
    const bookmarks = view.plan.items.flatMap((item) => item.bookmarks)
    const excluded = bookmarks.filter((bookmark) => excludedBookmarks.has(bookmark.id)).length
    const groups = view.plan.items.filter((item) => item.title !== '').length

    const parts = [`${bookmarks.length - excluded} 个标签`]
    if (groups > 0) parts.push(`${groups} 个分组`)
    if (excluded > 0) parts.push(`已勾掉 ${excluded}`)
    if (view.plan.skipped > 0) parts.push(`跳过 ${view.plan.skipped}`)
    return parts.join(' · ')
  }

  function matches(view: SessionView, term: string): boolean {
    if (!term) return true
    if (view.node.title.toLowerCase().includes(term)) return true
    return view.plan.items.some(
      (item) =>
        item.title.toLowerCase().includes(term) ||
        item.bookmarks.some((bookmark) =>
          `${bookmark.title} ${bookmark.url}`.toLowerCase().includes(term)
        )
    )
  }

  function bookmarkMarkup(bookmark: PlannedBookmark): string {
    const host = hostnameOf(bookmark.url) ?? bookmark.url
    return `
      <li class="tree__node">
        <label class="tree__row tree__row--bookmark">
          <input type="checkbox" data-content="${escapeHtml(bookmark.id)}" />
          ${faviconMarkup(bookmark.url, FAVICON_BASE)}
          <span class="tree__title">${escapeHtml(bookmark.title || bookmark.url)}</span>
          <span class="tree__meta">${escapeHtml(host)}</span>
        </label>
      </li>
    `
  }

  function itemMarkup(item: PlannedItem): string {
    // 散装书签项（title 为空）没有分组可建，直接铺成一列。
    // 分组项理论上一定有 folderId；万一没有，也不该造出一个 id 为空的勾选框。
    if (item.title === '' || !item.folderId) return item.bookmarks.map(bookmarkMarkup).join('')

    const containerId = item.folderId
    return `
      <li class="tree__node tree__node--group">
        <label class="tree__row tree__row--group">
          <input type="checkbox" data-content="${escapeHtml(containerId)}" />
          <span class="tree__title">${escapeHtml(item.title)}</span>
          <span class="tree__meta">${item.bookmarks.length} 个标签</span>
        </label>
        <ul class="tree__children">${item.bookmarks.map(bookmarkMarkup).join('')}</ul>
      </li>
    `
  }

  function sessionMarkup(view: SessionView): string {
    const id = view.node.id
    const open = expanded.has(id)

    const title =
      renaming?.id === id
        ? `<input type="text" class="input input--rename" data-rename-input="${escapeHtml(id)}"
                  value="${escapeHtml(view.node.title)}" aria-label="重命名存档" />`
        : `<span class="tree__title">${escapeHtml(view.node.title)}</span>`

    const actions =
      renaming?.id === id
        ? '<span class="tree__meta">回车保存，Esc 取消</span>'
        : `
          <span class="tree__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(id)}"
                    title="重命名这个存档文件夹">改名</button>
            ${
              pendingDeleteId === id
                ? `<button type="button" class="btn btn--danger btn--sm" data-confirm-delete="${escapeHtml(
                    id
                  )}" title="连同里面的书签一起删除">确认删除</button>
                   <button type="button" class="btn btn--ghost btn--sm" data-cancel-delete="">取消</button>`
                : `<button type="button" class="btn btn--ghost btn--sm" data-delete="${escapeHtml(
                    id
                  )}" title="删除这个存档">删除</button>`
            }
          </span>
        `

    const body =
      view.plan.items.length > 0
        ? view.plan.items.map(itemMarkup).join('')
        : '<li class="empty">这个存档里没有可还原的标签页。</li>'

    return `
      <li class="tree__node" data-session="${escapeHtml(id)}">
        <div class="tree__row">
          <button type="button" class="tree__caret" data-toggle="${escapeHtml(id)}"
                  aria-expanded="${open}" aria-label="${open ? '折叠' : '展开'}"
                  title="${open ? '折叠' : '展开'}">${open ? '▾' : '▸'}</button>
          <input type="checkbox" data-select="${escapeHtml(id)}"${
            selectedSessions.has(id) ? ' checked' : ''
          } title="选中这个存档，再用下方的按钮批量打开" />
          ${title}
          <span class="tree__meta" data-meta="${escapeHtml(id)}">${escapeHtml(
            sessionMetaText(view)
          )}</span>
          ${actions}
        </div>
        <ul class="tree__children" data-children="${escapeHtml(id)}"${open ? '' : ' hidden'}>
          ${body}
        </ul>
      </li>
    `
  }

  function render(): void {
    countBadge.textContent = String(sessions.length)
    contentInputs.clear()
    containerBookmarks.clear()
    sessionMetas.clear()

    if (!archiveAvailable) {
      rendered = []
      sessionList.innerHTML =
        '<li class="empty">还没有指定存档根文件夹，请到「设置」里选择。</li>'
      updateBulkBar()
      return
    }

    const term = searchInput.value.trim().toLowerCase()
    rendered = sessions.filter((view) => matches(view, term))

    // 只有「命中在里面的标签页」时才替用户展开，否则搜索还得再点一次。
    for (const view of rendered) {
      if (term && !view.node.title.toLowerCase().includes(term)) expanded.add(view.node.id)
    }

    if (rendered.length === 0) {
      sessionList.innerHTML = `<li class="empty">${
        sessions.length === 0 ? '存档里还没有文件夹，先保存一次当前窗口。' : '没有匹配的存档。'
      }</li>`
      updateBulkBar()
      return
    }

    sessionList.innerHTML = rendered.map(sessionMarkup).join('')

    for (const view of rendered) {
      containerBookmarks.set(
        view.node.id,
        view.plan.items.flatMap((item) => item.bookmarks.map((bookmark) => bookmark.id))
      )
      for (const item of view.plan.items) {
        if (item.folderId) {
          containerBookmarks.set(
            item.folderId,
            item.bookmarks.map((bookmark) => bookmark.id)
          )
        }
      }
      const meta = sessionList.querySelector<HTMLElement>(`[data-meta="${view.node.id}"]`)
      if (meta) sessionMetas.set(view.node.id, meta)
    }

    for (const input of sessionList.querySelectorAll<HTMLInputElement>('[data-content]')) {
      const id = input.dataset.content
      if (id) contentInputs.set(id, input)
    }

    applyContainerStates()
    updateBulkBar()

    if (renaming) {
      const input = sessionList.querySelector<HTMLInputElement>(
        `[data-rename-input="${renaming.id}"]`
      )
      input?.focus()
      input?.select()
    }
  }

  /** 让每个勾选框反映 `excludedBookmarks`：全选 / 半选 / 全不选。 */
  function applyContainerStates(): void {
    for (const [containerId, bookmarkIds] of containerBookmarks) {
      const input = contentInputs.get(containerId)
      if (!input) continue
      const kept = bookmarkIds.filter((id) => !excludedBookmarks.has(id)).length
      input.checked = kept > 0
      input.indeterminate = kept > 0 && kept < bookmarkIds.length
    }

    for (const view of rendered) {
      const meta = sessionMetas.get(view.node.id)
      if (meta) meta.textContent = sessionMetaText(view)
    }
  }

  /**
   * 选中的存档数——只数**当前可见**的（搜索过滤后的），
   * 因为三态勾选框管的是「列表里这些」，被搜索藏起来的不该把状态顶成「部分」。
   */
  function visibleSelectedCount(): number {
    return rendered.filter((view) => selectedSessions.has(view.node.id)).length
  }

  function selectedBookmarkCount(): number {
    let total = 0
    for (const id of selectedSessions) {
      const bookmarkIds = containerBookmarks.get(id) ?? []
      total += bookmarkIds.filter((bookmarkId) => !excludedBookmarks.has(bookmarkId)).length
    }
    return total
  }

  function updateBulkBar(): void {
    const count = selectedSessions.size

    selectAll.update(visibleSelectedCount(), rendered.length)

    const disabled = busy || count === 0
    openWindowButton.disabled = disabled
    openTabsButton.disabled = disabled
    openViewersButton.disabled = disabled
    expandAllButton.disabled = busy || sessions.length === 0
    collapseAllButton.disabled = busy || sessions.length === 0
  }

  async function refresh(): Promise<void> {
    settings = await loadSettings()

    const root = settings.archiveRootId ? await getSubTree(settings.archiveRootId) : undefined
    archiveAvailable = Boolean(root)
    openRootButton.hidden = !archiveAvailable

    sessions = (root?.children ?? [])
      .filter((child) => !child.url)
      .map((node) => ({node, plan: planRestore(node)}))

    // 存档被删或被改名后，勾掉的书签 id 可能已经不存在了。
    const alive = new Set(
      sessions.flatMap((view) => view.plan.items.flatMap((item) => item.bookmarks.map((b) => b.id)))
    )
    for (const id of [...excludedBookmarks]) {
      if (!alive.has(id)) excludedBookmarks.delete(id)
    }
    for (const id of [...selectedSessions]) {
      if (!sessions.some((view) => view.node.id === id)) selectedSessions.delete(id)
    }
    for (const id of [...expanded]) {
      if (!sessions.some((view) => view.node.id === id)) expanded.delete(id)
    }

    render()
  }

  /**
   * 打开选中的存档。
   *
   * `groupTabs: false` 是「只开标签页」——同一份勾选，只是不建标签分组。
   */
  async function runRestore(groupTabs: boolean): Promise<void> {
    if (busy || !settings) return
    const targets = [...selectedSessions]
    if (targets.length === 0) return

    busy = true
    updateBulkBar()
    setStatus(status, '正在打开…', 'ok')

    try {
      let opened = 0
      let groups = 0
      let skipped = 0
      for (const folderId of targets) {
        const result = await restoreFolder(folderId, {
          target: settings.restoreTarget,
          groupTabs,
          excludeBookmarkIds: excludedBookmarks
        })
        opened += result.opened
        groups += result.groups
        skipped += result.skipped
      }

      const parts = [`已打开 ${opened} 个标签页`]
      if (groups > 0) parts.push(`创建 ${groups} 个分组`)
      if (!groupTabs) parts.push('未建分组')
      if (skipped > 0) parts.push(`跳过 ${skipped} 项`)
      setStatus(status, `${parts.join('，')}。`, 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateBulkBar()
    }
  }

  async function runOpenViewers(folderIds: readonly string[], label: string): Promise<void> {
    if (busy || folderIds.length === 0) return

    busy = true
    updateBulkBar()
    setStatus(status, '正在打开…', 'ok')

    try {
      const opened = await openFolderViewers(folderIds)
      setStatus(status, `已打开 ${opened} 个${label}。`, 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateBulkBar()
    }
  }

  async function confirmDelete(sessionId: string): Promise<void> {
    const view = sessions.find((item) => item.node.id === sessionId)
    if (busy || !view) return

    busy = true
    pendingDeleteId = undefined
    updateBulkBar()

    try {
      await removeSubTree(sessionId)
      // 删掉的正是最后一次保存出来的会话时，「撤销」已经没有对象了。
      if (settings?.lastSessionFolderId === sessionId) {
        settings = await updateSettings({lastSessionFolderId: undefined})
      }
      selectedSessions.delete(sessionId)
      expanded.delete(sessionId)
      setStatus(status, `已删除存档「${view.node.title}」。`, 'ok')
    } catch (error) {
      setStatus(status, `删除失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await events.archiveChanged()
      updateBulkBar()
    }
  }

  /**
   * 清掉编辑状态。
   *
   * 改名是异步的：收尾时用户可能已经在改下一个存档了（点「改名」前会先触发上一个
   * 输入框的 focusout），所以只能清掉属于自己的那份状态。
   */
  function clearRenaming(sessionId: string): void {
    if (renaming?.id === sessionId) renaming = undefined
  }

  async function commitRename(input: HTMLInputElement, sessionId: string): Promise<void> {
    if (!renaming || renaming.id !== sessionId || renaming.committed) return
    renaming.committed = true

    const view = sessions.find((item) => item.node.id === sessionId)
    if (!view) return

    const next = sanitizeFolderName(input.value, view.node.title)
    if (next === view.node.title) {
      clearRenaming(sessionId)
      render()
      return
    }

    try {
      await renameNode(sessionId, next)
      setStatus(status, `已改名为「${next}」。`, 'ok')
    } catch (error) {
      setStatus(status, `改名失败：${errorText(error)}`, 'error')
    } finally {
      clearRenaming(sessionId)
      await events.archiveChanged()
    }
  }

  sessionList.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement

    const containerId = input.dataset.content
    if (containerId !== undefined) {
      for (const bookmarkId of containerBookmarks.get(containerId) ?? []) {
        if (input.checked) excludedBookmarks.delete(bookmarkId)
        else excludedBookmarks.add(bookmarkId)
      }
      // 只更新勾选态与计数：重建 DOM 会让键盘操作的焦点丢掉。
      applyContainerStates()
      updateBulkBar()
      return
    }

    const sessionId = input.dataset.select
    if (sessionId !== undefined) {
      if (input.checked) selectedSessions.add(sessionId)
      else selectedSessions.delete(sessionId)
      updateBulkBar()
    }
  })

  sessionList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const toggle = target.closest<HTMLButtonElement>('[data-toggle]')
    if (toggle?.dataset.toggle) {
      const sessionId = toggle.dataset.toggle
      const children = sessionList.querySelector<HTMLElement>(`[data-children="${sessionId}"]`)
      const open = !expanded.has(sessionId)
      if (open) expanded.add(sessionId)
      else expanded.delete(sessionId)
      toggle.textContent = open ? '▾' : '▸'
      toggle.setAttribute('aria-expanded', String(open))
      toggle.title = open ? '折叠' : '展开'
      if (children) children.hidden = !open
      return
    }

    const renameButton = target.closest<HTMLButtonElement>('[data-rename]')
    if (renameButton?.dataset.rename) {
      renaming = {id: renameButton.dataset.rename, committed: false}
      pendingDeleteId = undefined
      render()
      return
    }

    const deleteButton = target.closest<HTMLButtonElement>('[data-delete]')
    if (deleteButton?.dataset.delete) {
      pendingDeleteId = deleteButton.dataset.delete
      render()
      return
    }

    const confirmButton = target.closest<HTMLButtonElement>('[data-confirm-delete]')
    if (confirmButton?.dataset.confirmDelete) {
      void confirmDelete(confirmButton.dataset.confirmDelete)
      return
    }

    if (target.closest('[data-cancel-delete]')) {
      pendingDeleteId = undefined
      render()
    }
  })

  sessionList.addEventListener('keydown', (event) => {
    const input = event.target as HTMLInputElement
    const sessionId = input.dataset.renameInput
    if (sessionId === undefined) return

    if (event.key === 'Enter') {
      event.preventDefault()
      void commitRename(input, sessionId)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      renaming = undefined
      render()
    }
  })

  // 点开别处也算确认——不然改了名字却留在编辑框里，看着像没保存。
  sessionList.addEventListener(
    'focusout',
    (event) => {
      const input = event.target as HTMLInputElement
      const sessionId = input.dataset.renameInput
      if (sessionId !== undefined) void commitRename(input, sessionId)
    },
    true
  )

  searchInput.addEventListener('input', render)

  expandAllButton.addEventListener('click', () => {
    for (const view of sessions) expanded.add(view.node.id)
    render()
  })

  collapseAllButton.addEventListener('click', () => {
    expanded.clear()
    render()
  })

  openRootButton.addEventListener('click', () => {
    if (settings?.archiveRootId) void runOpenViewers([settings.archiveRootId], '阅读页')
  })

  openWindowButton.addEventListener('click', () => void runRestore(true))
  openTabsButton.addEventListener('click', () => void runRestore(false))
  openViewersButton.addEventListener('click', () =>
    void runOpenViewers([...selectedSessions], '阅读页')
  )

  return {element, refresh}
}
