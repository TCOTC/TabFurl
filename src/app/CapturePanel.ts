import {getNode, removeSubTree} from '../shared/bookmarks'
import {
  captureCurrentWindow,
  countSnapshotTabs,
  planSessionChildren,
  selectTabs,
  snapshotCurrentWindow,
  type SessionChild
} from '../shared/capture'
import {loadSettings, updateSettings} from '../shared/settings'
import {formatSessionName} from '../shared/naming'
import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {Settings, TabSnapshot, WindowSnapshot} from '../shared/types'
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
 * 「已固定」标记。
 *
 * 与折叠三角同一个理由：`📌` 是 emoji，各平台配色与大小都不一样，
 * 在一列灰字里就是一个突如其来的彩色块。换成与文件夹、刷新按钮同一套描边的内联 SVG。
 */
const PIN_ICON = `
  <svg class="icon icon--xs item__pin" viewBox="0 0 24 24" role="img" aria-label="已固定">
    <path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3Z"
          fill="currentColor" />
  </svg>
`

const TEMPLATE = `
  <h2 class="panel__title">保存当前窗口 <span class="badge" id="capture-count">0</span></h2>
  <label class="field">
    <span class="field__label">会话名（可选）</span>
    <input type="text" class="input" id="session-name" autocomplete="off"
           placeholder="留空则只用时间戳，例如：会议" />
  </label>
  <p class="muted" id="capture-preview"></p>
  <div class="row row--compact" id="tabs-all-host"></div>
  <ul class="pick-list" id="tab-list"></ul>
  <div class="row">
    <button type="button" class="btn btn--primary" id="capture-btn">保存当前窗口</button>
    <button type="button" class="btn btn--ghost" id="undo-btn" hidden>撤销上次保存</button>
  </div>
  <p class="status" id="capture-status" hidden></p>
`

/**
 * 「保存当前窗口」面板。
 *
 * 清单按与写入完全相同的顺序渲染（`planSessionChildren` 是唯一来源），
 * 计数也走 `countSnapshotTabs(selectTabs(...))`，所以「看到几枚就会存几枚」。
 */
export function createCapturePanel(events: AppEvents): Panel {
  const element = createPanelElement('capture')
  element.innerHTML = TEMPLATE

  const preview = q<HTMLParagraphElement>(element, '#capture-preview')
  const nameInput = q<HTMLInputElement>(element, '#session-name')
  const countBadge = q<HTMLSpanElement>(element, '#capture-count')
  const tabList = q<HTMLUListElement>(element, '#tab-list')
  const captureButton = q<HTMLButtonElement>(element, '#capture-btn')
  const undoButton = q<HTMLButtonElement>(element, '#undo-btn')
  const status = q<HTMLParagraphElement>(element, '#capture-status')

  const selectAll = createSelectAll(q<HTMLDivElement>(element, '#tabs-all-host'), {
    describe: (kept, total) =>
      total === 0
        ? '当前窗口没有可保存的标签页'
        : kept === total
          ? `已全选 ${total} 个标签页`
          : `已选 ${kept} / ${total} 个标签页`,
    onChange: (wantAll) => {
      if (wantAll) excluded.clear()
      else for (const tabId of allTabIds()) excluded.add(tabId)
      syncStates()
    }
  })

  let settings: Settings | undefined
  let archiveAvailable = false
  let busy = false

  let snapshot = emptySnapshot()
  let children: SessionChild[] = []
  const groupTabIds = new Map<number, number[]>()
  /**
   * 被勾掉的标签 id。
   *
   * 记「排除」而不是「选中」：标签被关掉、清单重排之后，用户没碰过的项才不会丢。
   * 用 `tabId` 而不是 `index`：后者会被别的标签关闭而整体前移。
   */
  const excluded = new Set<number>()

  function emptySnapshot(): WindowSnapshot {
    return {
      windowId: chrome.windows.WINDOW_ID_CURRENT,
      capturedAt: Date.now(),
      groups: [],
      ungrouped: [],
      skipped: 0
    }
  }

  /** 当前快照里的全部标签 id，供「全选 / 全不选」用。 */
  function allTabIds(): number[] {
    return [
      ...snapshot.groups.flatMap((bucket) => bucket.tabs.map((tab) => tab.tabId)),
      ...snapshot.ungrouped.map((tab) => tab.tabId)
    ]
  }

  function tabMarkup(tab: TabSnapshot): string {
    const host = hostnameOf(tab.url) ?? tab.url
    return `
      <li class="item pick">
        <input type="checkbox" data-tab="${tab.tabId}"${
          excluded.has(tab.tabId) ? '' : ' checked'
        } />
        ${faviconMarkup(tab.url, FAVICON_BASE)}
        <span class="item__main">
          <span class="item__title">${escapeHtml(tab.title || tab.url)}${
            tab.pinned ? PIN_ICON : ''
          }</span>
          <span class="item__meta">${escapeHtml(host)}</span>
        </span>
      </li>
    `
  }

  function groupMarkup(child: Extract<SessionChild, {kind: 'group'}>, index: number): string {
    groupTabIds.set(
      index,
      child.tabs.map((tab) => tab.tabId)
    )
    return `
      <li class="pick pick--group">
        <label class="item pick__row">
          <input type="checkbox" data-group="${index}" />
          <span class="item__title">${escapeHtml(child.name)}</span>
          <span class="item__meta">${child.tabs.length} 个标签</span>
        </label>
        <ul class="pick__children">${child.tabs.map(tabMarkup).join('')}</ul>
      </li>
    `
  }

  function render(): void {
    children = planSessionChildren(snapshot)
    groupTabIds.clear()

    countBadge.textContent = String(countSnapshotTabs(snapshot))

    if (children.length === 0) {
      tabList.innerHTML = '<li class="empty">当前窗口没有可保存的标签页。</li>'
      syncStates()
      return
    }

    tabList.innerHTML = children
      .map((child, index) => (child.kind === 'tab' ? tabMarkup(child.tab) : groupMarkup(child, index)))
      .join('')

    syncStates()
  }

  /**
   * 让每个勾选框反映 `excluded`。
   *
   * 只改状态、不重建 DOM：勾选时重建会让键盘用户每按一次空格就丢一次焦点。
   */
  function syncStates(): void {
    for (const input of tabList.querySelectorAll<HTMLInputElement>('[data-tab]')) {
      input.checked = !excluded.has(Number(input.dataset.tab))
    }

    for (const [index, tabIds] of groupTabIds) {
      const input = tabList.querySelector<HTMLInputElement>(`[data-group="${index}"]`)
      if (!input) continue
      const kept = tabIds.filter((tabId) => !excluded.has(tabId)).length
      input.checked = kept > 0
      input.indeterminate = kept > 0 && kept < tabIds.length
    }

    updateBar()
  }

  /**
   * 「将存成什么」与「这一存有哪些边角情况」合成一行。
   *
   * 以前是上下两行灰字：一行预览名字，一行报「窗口里有 N 个可保存的标签页，M 个分组，
   * 跳过 K 个内部页面」。但标签页总数在同一屏里已经出现两次（标题旁的数字、
   * 勾选框旁的「已全选 N 个」），那两行里实际只有一行带新信息。
   * 合成一行后列表多出约 30px，小窗口下正好多显一行标签。
   */
  function updatePreview(): void {
    if (!archiveAvailable) {
      preview.textContent = '先在上方选一个存档位置。'
      return
    }
    const parts = [`将存成：${formatSessionName(new Date(), nameInput.value)}`]
    if (snapshot.groups.length > 0) parts.push(`${snapshot.groups.length} 个标签分组`)
    if (snapshot.skipped > 0) parts.push(`跳过 ${snapshot.skipped} 个内部页面`)
    preview.textContent = parts.join(' · ')
  }

  function updateBar(): void {
    const total = countSnapshotTabs(snapshot)
    const kept = countSnapshotTabs(selectTabs(snapshot, excluded))

    selectAll.update(kept, total)

    captureButton.textContent = busy
      ? '保存中…'
      : kept === total ? '保存整个窗口' : `保存选中的 ${kept} 个标签页`
    captureButton.disabled = busy || kept === 0 || !archiveAvailable
    undoButton.disabled = busy
  }

  async function refresh(): Promise<void> {
    settings = await loadSettings()
    archiveAvailable = Boolean(
      settings.archiveRootId && (await getNode(settings.archiveRootId))
    )
    undoButton.hidden = !settings.lastSessionFolderId

    snapshot = await snapshotCurrentWindow()

    // 标签被关掉之后它的 tabId 不会再出现；留着只会让集合越涨越大。
    const alive = new Set([
      ...snapshot.groups.flatMap((bucket) => bucket.tabs.map((tab) => tab.tabId)),
      ...snapshot.ungrouped.map((tab) => tab.tabId)
    ])
    for (const tabId of [...excluded]) {
      if (!alive.has(tabId)) excluded.delete(tabId)
    }

    // 上面那行 alive 只用于修剪勾选集合；给用户看的数字在角标、勾选框与预览行里。
    updatePreview()
    render()
  }

  async function runCapture(): Promise<void> {
    if (busy || !settings?.archiveRootId) return
    busy = true
    updateBar()

    try {
      const result = await captureCurrentWindow(settings.archiveRootId, {
        name: nameInput.value,
        excludeTabIds: excluded
      })
      if (result.saved === 0) {
        setStatus(status, '没有勾选任何标签页。', 'error')
      } else {
        await updateSettings({lastSessionFolderId: result.folderId})
        const parts = [`已保存 ${result.saved} 个标签页到「${result.folderName}」`]
        if (result.groups > 0) parts.push(`创建 ${result.groups} 个分组`)
        if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个内部页面`)
        setStatus(status, `${parts.join('，')}。`, 'ok')
        // 名字不记住：下次保存从空白开始；这次勾选已经落盘，也从「全选」重来。
        nameInput.value = ''
        excluded.clear()
      }
    } catch (error) {
      setStatus(status, `保存失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await refresh()
      await events.archiveChanged()
      updateBar()
    }
  }

  async function runUndo(): Promise<void> {
    const folderId = settings?.lastSessionFolderId
    if (busy || !folderId) return
    busy = true
    updateBar()

    try {
      await removeSubTree(folderId)
      await updateSettings({lastSessionFolderId: undefined})
      setStatus(status, '已撤销上一次保存。', 'ok')
    } catch (error) {
      setStatus(status, `撤销失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await refresh()
      await events.archiveChanged()
      updateBar()
    }
  }

  tabList.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement

    const tabId = input.dataset.tab
    if (tabId !== undefined) {
      // 叶子：单枚标签，两态，直接看原生结果。
      if (input.checked) excluded.delete(Number(tabId))
      else excluded.add(Number(tabId))
    }

    const groupIndex = input.dataset.group
    if (groupIndex !== undefined) {
      // 分组：按三态推意图，与顶层勾选框同一套规则（部分选择 → 全选）。
      const tabIds = groupTabIds.get(Number(groupIndex)) ?? []
      const kept = tabIds.filter((id) => !excluded.has(id)).length
      const wantAll = nextSelectAll(triState(kept, tabIds.length))
      for (const id of tabIds) {
        if (wantAll) excluded.delete(id)
        else excluded.add(id)
      }
    }

    syncStates()
  })

  captureButton.addEventListener('click', () => void runCapture())
  undoButton.addEventListener('click', () => void runUndo())
  nameInput.addEventListener('input', updatePreview)

  // 主界面是一个标签页，用户随时会去动标签；不跟着刷新的话清单会过期。
  // 面板不可见时不刷新，省下每次标签变化的 snapshot 开销。
  let timer: number | undefined

  function scheduleRefresh(): void {
    if (element.hidden) return
    if (timer !== undefined) clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      void refresh()
    }, 200)
  }

  chrome.tabs.onCreated.addListener(scheduleRefresh)
  chrome.tabs.onRemoved.addListener(scheduleRefresh)
  chrome.tabs.onMoved.addListener(scheduleRefresh)
  chrome.tabs.onAttached.addListener(scheduleRefresh)
  chrome.tabs.onDetached.addListener(scheduleRefresh)
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // 标题变化会疯狂触发，只有地址或分组变了才值得重排清单。
    if (changeInfo.url !== undefined || changeInfo.groupId !== undefined) scheduleRefresh()
  })
  chrome.tabGroups.onUpdated.addListener(scheduleRefresh)
  chrome.tabGroups.onRemoved.addListener(scheduleRefresh)

  return {element, refresh}
}
