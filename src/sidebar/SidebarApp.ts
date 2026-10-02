import {getNode, listFolders, removeSubTree} from '../shared/bookmarks'
import {captureCurrentWindow, countCapturableTabs} from '../shared/capture'
import {openFolderViewers, restoreFolder} from '../shared/restore'
import {loadSettings, updateSettings} from '../shared/settings'
import {escapeHtml} from '../shared/tile'
import type {FolderOption, Settings} from '../shared/types'

type StatusKind = 'ok' | 'error'

const ROOT_TEMPLATE = `
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">TabFurl</h1>
      <p class="app__subtitle">窗口 ⇄ 收藏文件夹</p>
    </header>

    <section class="panel">
      <h2 class="panel__title">保存当前窗口</h2>
      <p class="muted" id="capture-hint"></p>
      <div class="row">
        <button type="button" class="btn btn--primary" id="capture-btn">保存当前窗口</button>
        <button type="button" class="btn btn--ghost" id="undo-btn" hidden>撤销</button>
      </div>
      <p class="status" id="capture-status" hidden></p>
    </section>

    <section class="panel panel--folders">
      <h2 class="panel__title">存档文件夹 <span class="badge" id="folder-count">0</span></h2>
      <input type="search" class="input" id="search" placeholder="搜索文件夹…" autocomplete="off" />
      <div class="row row--compact">
        <button type="button" class="btn btn--ghost btn--sm" id="select-all-btn">全选</button>
        <button type="button" class="btn btn--ghost btn--sm" id="select-none-btn">清空</button>
        <span class="muted" id="selected-count">未选中</span>
      </div>
      <ul class="list" id="folder-list"></ul>
      <div class="row">
        <button type="button" class="btn btn--primary" id="open-window-btn" disabled>打开为窗口</button>
        <button type="button" class="btn" id="open-tabs-btn" disabled>各开一个标签页</button>
      </div>
      <p class="status" id="restore-status" hidden></p>
    </section>

    <footer class="app__footer">
      <a class="link" id="options-link" href="#">设置</a>
      <a class="link" id="docs-link" href="#" hidden>查看存档根</a>
    </footer>
  </main>
`

function q<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`缺少必需的 DOM 节点：${selector}`)
  return element as T
}

function SidebarApp(): void {
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = ROOT_TEMPLATE

  const captureHint = q<HTMLParagraphElement>(root, '#capture-hint')
  const captureButton = q<HTMLButtonElement>(root, '#capture-btn')
  const undoButton = q<HTMLButtonElement>(root, '#undo-btn')
  const captureStatus = q<HTMLParagraphElement>(root, '#capture-status')
  const folderCount = q<HTMLSpanElement>(root, '#folder-count')
  const searchInput = q<HTMLInputElement>(root, '#search')
  const selectAllButton = q<HTMLButtonElement>(root, '#select-all-btn')
  const selectNoneButton = q<HTMLButtonElement>(root, '#select-none-btn')
  const selectedCount = q<HTMLSpanElement>(root, '#selected-count')
  const folderList = q<HTMLUListElement>(root, '#folder-list')
  const openWindowButton = q<HTMLButtonElement>(root, '#open-window-btn')
  const openTabsButton = q<HTMLButtonElement>(root, '#open-tabs-btn')
  const restoreStatus = q<HTMLParagraphElement>(root, '#restore-status')
  const optionsLink = q<HTMLAnchorElement>(root, '#options-link')
  const docsLink = q<HTMLAnchorElement>(root, '#docs-link')

  let settings: Settings | undefined
  let folders: FolderOption[] = []
  const selected = new Set<string>()
  let busy = false

  function setStatus(
    element: HTMLParagraphElement,
    message: string,
    kind: StatusKind
  ): void {
    if (!message) {
      element.hidden = true
      element.textContent = ''
      return
    }
    element.hidden = false
    element.className = `status status--${kind}`
    element.textContent = message
  }

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  function visibleFolders(): FolderOption[] {
    const term = searchInput.value.trim().toLowerCase()
    if (!term) return folders
    return folders.filter((folder) =>
      `${folder.path.join(' ')} ${folder.title}`.toLowerCase().includes(term)
    )
  }

  function updateSelectionUi(): void {
    const count = selected.size
    selectedCount.textContent = count === 0 ? '未选中' : `已选 ${count} 个`
    openWindowButton.disabled = busy || count === 0
    openTabsButton.disabled = busy || count === 0
  }

  function renderFolders(): void {
    const items = visibleFolders()
    folderCount.textContent = String(folders.length)

    if (items.length === 0) {
      folderList.innerHTML = `<li class="empty">${
        folders.length === 0 ? '存档里还没有文件夹，先保存一次当前窗口。' : '没有匹配的文件夹。'
      }</li>`
      updateSelectionUi()
      return
    }

    folderList.innerHTML = items
      .map((folder) => {
        const indent = folder.path.length * 12
        const parent = folder.path.length === 0 ? '存档根下' : folder.path.join(' / ')
        const parts: string[] = []
        if (folder.folderCount > 0) parts.push(`${folder.folderCount} 个子文件夹`)
        if (folder.totalBookmarkCount > 0) parts.push(`${folder.totalBookmarkCount} 个书签`)
        return `
          <li class="list__item" style="padding-left:${8 + indent}px">
            <input type="checkbox" data-folder-id="${escapeHtml(folder.id)}"${
              selected.has(folder.id) ? ' checked' : ''
            } />
            <span class="list__main">
              <span class="list__title">${escapeHtml(folder.title)}</span>
              <span class="list__meta">${escapeHtml(parent)}${
                parts.length > 0 ? ` · ${escapeHtml(parts.join('，'))}` : ''
              }</span>
            </span>
          </li>
        `
      })
      .join('')

    updateSelectionUi()
  }

  function updateCaptureHint(counts: {saveable: number; skipped: number}): void {
    if (counts.saveable === 0) {
      captureHint.textContent = '当前窗口没有可保存的标签页。'
      return
    }
    const suffix = counts.skipped > 0 ? `，跳过 ${counts.skipped} 个内部页面` : ''
    captureHint.textContent = `将保存 ${counts.saveable} 个标签页${suffix}`
  }

  async function refresh(): Promise<void> {
    settings = await loadSettings()

    if (!settings.archiveRootId || !(await getNode(settings.archiveRootId))) {
      folders = []
      folderList.innerHTML =
        '<li class="empty">还没有存档根文件夹，请到设置页创建。</li>'
      folderCount.textContent = '0'
      docsLink.hidden = true
      captureButton.disabled = true
      captureHint.textContent = '需要先在设置页创建存档根文件夹。'
      updateSelectionUi()
      return
    }

    captureButton.disabled = busy
    folders = await listFolders(settings.archiveRootId)
    docsLink.hidden = false
    docsLink.onclick = (event) => {
      event.preventDefault()
      if (settings?.archiveRootId) void openFolderViewers([settings.archiveRootId])
    }

    renderFolders()
    updateCaptureHint(await countCapturableTabs())

    undoButton.hidden = !settings.lastSessionFolderId
    setStatus(captureStatus, '', 'ok')
  }

  searchInput.addEventListener('input', renderFolders)

  folderList.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement
    const id = input.dataset.folderId
    if (!id) return
    if (input.checked) selected.add(id)
    else selected.delete(id)
    updateSelectionUi()
  })

  selectAllButton.addEventListener('click', () => {
    for (const folder of visibleFolders()) selected.add(folder.id)
    renderFolders()
  })

  selectNoneButton.addEventListener('click', () => {
    selected.clear()
    renderFolders()
  })

  optionsLink.addEventListener('click', (event) => {
    event.preventDefault()
    void chrome.runtime.openOptionsPage()
  })

  captureButton.addEventListener('click', async () => {
    if (busy || !settings?.archiveRootId) return
    busy = true
    captureButton.disabled = true
    captureButton.textContent = '保存中…'

    try {
      const result = await captureCurrentWindow(
        settings.archiveRootId,
        settings.sessionNameMode
      )
      if (result.saved === 0) {
        setStatus(captureStatus, '当前窗口没有可保存的标签页。', 'error')
      } else {
        await updateSettings({lastSessionFolderId: result.folderId})
        const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 个内部页面` : ''
        setStatus(
          captureStatus,
          `已保存 ${result.saved} 个标签页到「${result.folderName}」${skipped}`,
          'ok'
        )
      }
    } catch (error) {
      setStatus(captureStatus, `保存失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      captureButton.textContent = '保存当前窗口'
      await refresh()
      busy = false
    }
  })

  undoButton.addEventListener('click', async () => {
    const folderId = settings?.lastSessionFolderId
    if (busy || !folderId) return
    busy = true
    try {
      await removeSubTree(folderId)
      await updateSettings({lastSessionFolderId: undefined})
      setStatus(captureStatus, '已撤销上一次保存。', 'ok')
    } catch (error) {
      setStatus(captureStatus, `撤销失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      await refresh()
      busy = false
    }
  })

  openWindowButton.addEventListener('click', async () => {
    if (busy || !settings) return
    const targets = [...selected]
    busy = true
    setStatus(restoreStatus, '正在打开…', 'ok')
    try {
      let opened = 0
      let groups = 0
      for (const folderId of targets) {
        const result = await restoreFolder(folderId, {target: settings.restoreTarget})
        opened += result.opened
        groups += result.groups
      }
      setStatus(restoreStatus, `已打开 ${opened} 个标签页，创建 ${groups} 个分组。`, 'ok')
    } catch (error) {
      setStatus(restoreStatus, `打开失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateSelectionUi()
    }
  })

  openTabsButton.addEventListener('click', async () => {
    if (busy) return
    busy = true
    setStatus(restoreStatus, '正在打开…', 'ok')
    try {
      const opened = await openFolderViewers([...selected])
      setStatus(restoreStatus, `已打开 ${opened} 个文件夹标签页。`, 'ok')
    } catch (error) {
      setStatus(restoreStatus, `打开失败：${errorText(error)}`, 'error')
    } finally {
      busy = false
      updateSelectionUi()
    }
  })

  void refresh()
}

SidebarApp()
