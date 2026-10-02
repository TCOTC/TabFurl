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
import {decorateTiles, escapeHtml, tileMarkup} from '../shared/tile'
import type {Settings, TabSnapshot, WindowSnapshot} from '../shared/types'
import {hostnameOf} from '../shared/urls'
import {
  createPanelElement,
  errorText,
  q,
  setStatus,
  type AppEvents,
  type Panel
} from './dom'

/** Chrome 本地 favicon 缓存端点：读缓存、不联网（配合 `tileMarkup` 使用）。 */
const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

const TEMPLATE = `
  <h2 class="panel__title">保存当前窗口 <span class="badge" id="capture-count">0</span></h2>
  <label class="field">
    <span class="field__label">会话名（可选）</span>
    <input type="text" class="input" id="session-name" autocomplete="off"
           placeholder="留空则只用时间戳，例如：会议" />
  </label>
  <p class="muted" id="capture-preview"></p>
  <p class="muted" id="capture-hint"></p>
  <div class="row row--compact">
    <button type="button" class="btn btn--ghost btn--sm" id="tabs-all-btn">全选</button>
    <button type="button" class="btn btn--ghost btn--sm" id="tabs-none-btn">清空</button>
    <span class="muted" id="tabs-selected"></span>
  </div>
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

  const hint = q<HTMLParagraphElement>(element, '#capture-hint')
  const preview = q<HTMLParagraphElement>(element, '#capture-preview')
  const nameInput = q<HTMLInputElement>(element, '#session-name')
  const countBadge = q<HTMLSpanElement>(element, '#capture-count')
  const allButton = q<HTMLButtonElement>(element, '#tabs-all-btn')
  const noneButton = q<HTMLButtonElement>(element, '#tabs-none-btn')
  const selectedLabel = q<HTMLSpanElement>(element, '#tabs-selected')
  const tabList = q<HTMLUListElement>(element, '#tab-list')
  const captureButton = q<HTMLButtonElement>(element, '#capture-btn')
  const undoButton = q<HTMLButtonElement>(element, '#undo-btn')
  const status = q<HTMLParagraphElement>(element, '#capture-status')

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

  function tabMarkup(tab: TabSnapshot): string {
    const host = hostnameOf(tab.url) ?? tab.url
    return `
      <li class="pick">
        <input type="checkbox" data-tab="${tab.tabId}"${
          excluded.has(tab.tabId) ? '' : ' checked'
        } />
        ${tileMarkup(tab.title, tab.url, FAVICON_BASE)}
        <span class="pick__main">
          <span class="pick__title">${escapeHtml(tab.title || tab.url)}${
            tab.pinned ? '<span class="pick__pin" title="已固定">📌</span>' : ''
          }</span>
          <span class="pick__meta">${escapeHtml(host)}</span>
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
        <label class="pick__row">
          <input type="checkbox" data-group="${index}" />
          <span class="pick__title">${escapeHtml(child.name)}</span>
          <span class="pick__meta">${child.tabs.length} 个标签</span>
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

    decorateTiles(tabList)
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

  function updatePreview(): void {
    // 直接用命名函数生成，所以预览与真正写入书签的名字完全一致（含清洗与截断）。
    preview.textContent = `将存成：${formatSessionName(new Date(), nameInput.value)}`
  }

  function updateBar(): void {
    const total = countSnapshotTabs(snapshot)
    const kept = countSnapshotTabs(selectTabs(snapshot, excluded))

    selectedLabel.textContent =
      total === 0 ? '' : kept === total ? `已全选 ${total} 个` : `已选 ${kept} / ${total} 个`

    captureButton.textContent = busy
      ? '保存中…'
      : kept === total ? '保存整个窗口' : `保存选中的 ${kept} 个标签页`
    captureButton.disabled = busy || kept === 0 || !archiveAvailable
    allButton.disabled = busy || total === 0
    noneButton.disabled = busy || total === 0
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

    const parts = [`主界面所在窗口有 ${alive.size} 个可保存的标签页`]
    if (snapshot.groups.length > 0) parts.push(`${snapshot.groups.length} 个标签分组`)
    if (snapshot.skipped > 0) parts.push(`跳过 ${snapshot.skipped} 个内部页面`)
    hint.textContent = archiveAvailable
      ? `${parts.join('，')}。取消勾选即不保存。`
      : '需要先在「设置」里指定存档根文件夹。'

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
      if (input.checked) excluded.delete(Number(tabId))
      else excluded.add(Number(tabId))
    }

    const groupIndex = input.dataset.group
    if (groupIndex !== undefined) {
      for (const id of groupTabIds.get(Number(groupIndex)) ?? []) {
        if (input.checked) excluded.delete(id)
        else excluded.add(id)
      }
    }

    syncStates()
  })

  allButton.addEventListener('click', () => {
    excluded.clear()
    render()
  })

  noneButton.addEventListener('click', () => {
    for (const child of children) {
      if (child.kind === 'tab') excluded.add(child.tab.tabId)
      else for (const tab of child.tabs) excluded.add(tab.tabId)
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
