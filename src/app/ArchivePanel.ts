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
  nextSelectAll,
  q,
  setStatus,
  triState,
  type AppEvents,
  type Panel
} from './dom'

/** Chrome 本地 favicon 缓存端点：读缓存、不联网（配合 `tileMarkup` 使用）。 */
const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

/**
 * 折叠三角。
 *
 * 用 SVG 而不是 `▸` / `▾` 这个字形：三角形在字体里比字身小得多，大小与粗细全看
 * 系统字体怎么画（Windows 与 macOS 差得很明显），想调只能动字号、连带着撑高行。
 * SVG 的量级由我们说了算，而且能靠 `currentColor` 跟主题走。
 *
 * 顶点朝下表示「已展开」（再点会收起），朝右表示「已收起」。
 */
function caretSvg(open: boolean): string {
  // 两个三角形的**包围盒中心**都落在 viewBox 正中（7,7），切换时不会跳动。
  //  收起（顶点朝右）：x∈[3,11] y∈[2,12] → 中心 (7,7)
  //  展开（顶点朝下）：x∈[2,12] y∈[3,11] → 中心 (7,7)
  // 按包围盒居中（而不是三角形形心）是图标集里的通行做法：形心会随朝向偏移，
  // 视觉上反而像没对齐。
  const points = open ? '2,3 12,3 7,11' : '3,2 11,7 3,12'
  return (
    '<svg class="caret" viewBox="0 0 14 14" aria-hidden="true">' +
    `<polygon points="${points}" fill="currentColor" />` +
    '</svg>'
  )
}

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
    describe: (kept, total, filtered) => {
      if (total === 0) return '没有可还原的标签页'
      const base =
        kept === 0
          ? `尚未勾选（列表里共 ${total} 枚标签页），勾选后才能还原`
          : `已选 ${kept} / ${total} 枚标签页 · ${targets().length} 个存档`
      return filtered ? `${base}（仅列表可见）` : base
    },
    onChange: (wantAll) => {
      // 与三态框自己的范围一致：只管列表里可见的那些存档。
      for (const view of rendered) {
        const ids = containerBookmarks.get(view.node.id) ?? []
        for (const id of ids) {
          if (wantAll) excludedBookmarks.delete(id)
          else excludedBookmarks.add(id)
        }
      }
      applyContainerStates()
      updateBulkBar()
    }
  })

  let settings: Settings | undefined
  let archiveAvailable = false
  let busy = false

  let sessions: SessionView[] = []
  let rendered: SessionView[] = []
  const expanded = new Set<string>()
  /**
   * 被勾掉的书签 id（跨存档共用一个集合，书签 id 本身全局唯一）。
   *
   * **只有这一个勾选维度**：一枚书签要么会被还原、要么不会。存档行与分组行都是它上面
   * 的聚合（三态），所以不存在「看着全选、但按钮说没选中」这种自相矛盾。
   *
   * 存档侧**默认一个都不勾**：还原是「要打开哪些」的动作，默认全开太危险。
   * 实现上仍然用排除集（而不是选中集），配合下面的 `knownBookmarks`：
   * 没见过的书签一律算排除。这样既满足「默认不勾」，重渲染又不会弄丢用户已做的勾选。
   */
  const excludedBookmarks = new Set<string>()
  /** 已经出现过的书签 id。新出现的一律默认算排除。 */
  const knownBookmarks = new Set<string>()
  const contentInputs = new Map<string, HTMLInputElement>()
  /** 容器 id（会话或分组）→ 它包含的书签 id，用于整组勾选与计数。 */
  const containerBookmarks = new Map<string, string[]>()
  const sessionMetas = new Map<string, HTMLElement>()
  let pendingDeleteId: string | undefined
  let renaming: {id: string; committed: boolean} | undefined

  /**
   * 会话行的副文案。
   *
   * 默认一个都不勾，所以**不能**把「还会还原的枚数」直接写成「N 个标签」——
   * 那会显示成「0 个标签」，看着像这个存档是空的。改成以「已选」为主。
   */
  function sessionMetaText(view: SessionView): string {
    const bookmarks = view.plan.items.flatMap((item) => item.bookmarks)
    const total = bookmarks.length
    const kept = bookmarks.filter((bookmark) => !excludedBookmarks.has(bookmark.id)).length
    const groups = view.plan.items.filter((item) => item.title !== '').length

    const parts = [
      kept === 0
        ? `未勾选 · 共 ${total} 枚标签`
        : kept === total
          ? `已全选 ${total} 枚标签`
          : `已选 ${kept} / ${total} 枚标签`
    ]
    if (groups > 0) parts.push(`${groups} 个分组`)
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
                  title="${open ? '折叠' : '展开'}">${caretSvg(open)}</button>
          <input type="checkbox" data-content="${escapeHtml(id)}"
                 title="这个存档里哪些标签要还原" />
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

  /**
   * 让每个勾选框反映 `excludedBookmarks`：
   * 容器（存档 / 分组）是三态，叶子（单枚标签）是两态。
   *
   * 叶子也必须在这里同步。它们渲染时一律不带 `checked`（`bookmarkMarkup` 不写它），
   * 所以不在此处补上，叶子会永远显示成未勾选——而模型里其实是勾选的，
   * 于是点一下反而变成「不排除」，什么都不会发生。
   */
  function applyContainerStates(): void {
    for (const [containerId, input] of contentInputs) {
      const bookmarkIds = containerBookmarks.get(containerId)

      if (!bookmarkIds) {
        // 叶子：单枚书签。
        input.checked = !excludedBookmarks.has(containerId)
        continue
      }

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
   * 列表里可见的标签勾选概况：`kept` 是还会被还原的枚数，`total` 是可见的总枚数。
   *
   * 顶层三态按**标签**聚合，而不按「有几个存档还有东西」：勾选的真正维度是标签，
   * 按存档聚合会出现「已选 4 / 5 枚」却显示全选这种对不上（3 个存档都至少留了一枚）。
   * 搜索过滤时只算可见的，被藏起来的不会把状态顶成「部分」。
   */
  function visibleTotals(): {kept: number; total: number} {
    let kept = 0
    let total = 0
    for (const view of rendered) {
      const count = (containerBookmarks.get(view.node.id) ?? []).length
      total += count
      kept += keptCount(view.node.id)
    }
    return {kept, total}
  }

  /** 某个容器（存档 / 分组）里还剩几枚被勾选的标签。 */
  function keptCount(containerId: string): number {
    const ids = containerBookmarks.get(containerId) ?? []
    return ids.filter((id) => !excludedBookmarks.has(id)).length
  }

  /**
   * 当前的还原目标：列表里可见、且至少还剩一枚被勾选标签的存档。
   *
   * 局限在可见范围是刻意的一致选择：三态框、按钮上的数量、真正打开的东西三者用同一个集合，
   * 用户搜索过滤后不会出现「按钮写着 12 个存档、实际只开了 3 个」这种对不上。
   * 搜索过滤时，三态框的文案会明写「仅列表可见」。
   */
  function targets(): SessionView[] {
    return rendered.filter((view) => keptCount(view.node.id) > 0)
  }

  /** 目标里的标签总数（即「会打开多少个标签页」）。 */
  function targetBookmarkCount(): number {
    return targets().reduce((sum, view) => sum + keptCount(view.node.id), 0)
  }

  function updateBulkBar(): void {
    const targetsCount = targets().length
    const tabs = targetBookmarkCount()
    const filtered = searchInput.value.trim().length > 0

    const {kept, total} = visibleTotals()
    selectAll.update(kept, total, filtered)

    // 数量写在按钮上：得让人在点之前看见这一下会打开多少。
    openWindowButton.textContent = `还原为窗口（${tabs} 个标签页 / ${targetsCount} 个存档）`
    openTabsButton.textContent = `只开标签页（${tabs} 个标签页 / ${targetsCount} 个存档）`
    openViewersButton.textContent = `打开阅读页（${targetsCount} 个）`

    const disabled = busy || targetsCount === 0
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
    // 第一次见到的书签默认算排除（存档侧默认一个都不勾）。
    // 新保存出来的存档同理：它里面的标签从一开始就不勾，免得「刚存完就被下一次还原顺手打开」。
    for (const id of alive) {
      if (!knownBookmarks.has(id)) {
        knownBookmarks.add(id)
        excludedBookmarks.add(id)
      }
    }
    for (const id of [...knownBookmarks]) {
      if (!alive.has(id)) knownBookmarks.delete(id)
    }
    for (const id of [...excludedBookmarks]) {
      if (!alive.has(id)) excludedBookmarks.delete(id)
    }
    for (const id of [...expanded]) {
      if (!sessions.some((view) => view.node.id === id)) expanded.delete(id)
    }

    render()
  }

  /**
   * 打开还原目标。
   *
   * `groupTabs: false` 是「只开标签页」——同一份勾选，只是不建分组。
   */
  async function runRestore(groupTabs: boolean): Promise<void> {
    if (busy || !settings) return
    const folderIds = targets().map((view) => view.node.id)
    if (folderIds.length === 0) return

    busy = true
    updateBulkBar()
    // 这一句必须留：舍弃前要等导航提交（最多 2 秒），没有它界面看起来就是卡住的。
    setStatus(status, '正在打开…', 'ok')

    try {
      for (const folderId of folderIds) {
        await restoreFolder(folderId, {
          target: settings.restoreTarget,
          groupTabs,
          excludeBookmarkIds: excludedBookmarks
        })
      }
      // 成功不留报账式提示：标签/窗口已经打开，看得见；数字写在按钮上，点之前就看到了。
      setStatus(status, '', 'ok')
    } catch (error) {
      setStatus(status, `打开失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateBulkBar()
    }
  }

  async function runOpenViewers(folderIds: readonly string[]): Promise<void> {
    if (busy || folderIds.length === 0) return

    busy = true
    updateBulkBar()
    setStatus(status, '正在打开…', 'ok')

    try {
      await openFolderViewers(folderIds)
      setStatus(status, '', 'ok')
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
    const id = input.dataset.content
    if (id === undefined) return

    const container = containerBookmarks.get(id)
    if (container) {
      // 容器（存档 / 分组）：按三态推意图，与顶层勾选框同一套规则。
      // 不能读原生取反的结果，否则「部分选择」会变成「全不选」。
      const kept = container.filter((bookmarkId) => !excludedBookmarks.has(bookmarkId)).length
      const wantAll = nextSelectAll(triState(kept, container.length))
      for (const bookmarkId of container) {
        if (wantAll) excludedBookmarks.delete(bookmarkId)
        else excludedBookmarks.add(bookmarkId)
      }
    } else {
      // 叶子：单枚标签，两态，直接看原生结果。
      if (input.checked) excludedBookmarks.delete(id)
      else excludedBookmarks.add(id)
    }

    // 只更新勾选态与计数：重建 DOM 会让键盘操作的焦点丢掉。
    applyContainerStates()
    updateBulkBar()
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
      // 换掉整个 SVG，而不是改 textContent。
      toggle.innerHTML = caretSvg(open)
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
    if (settings?.archiveRootId) void runOpenViewers([settings.archiveRootId])
  })

  openWindowButton.addEventListener('click', () => void runRestore(true))
  openTabsButton.addEventListener('click', () => void runRestore(false))
  openViewersButton.addEventListener('click', () =>
    void runOpenViewers(targets().map((view) => view.node.id))
  )

  return {element, refresh}
}
