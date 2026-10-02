import {getNodePath, getSubTree} from '../src/shared/bookmarks'
import {restoreFolder} from '../src/shared/restore'
import {loadSettings} from '../src/shared/settings'
import {decorateTiles, escapeHtml, tileMarkup} from '../src/shared/tile'
import type {BookmarkNode} from '../src/shared/types'
import {hostnameOf} from '../src/shared/urls'
import '../src/shared/base.css'
import './folder.css'

/** Chrome 本地 favicon 缓存端点：读缓存、不联网（配合 `tileMarkup` 使用）。 */
const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

function q<T extends Element>(selector: string): T {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`缺少必需的 DOM 节点：${selector}`)
  return element as T
}

function bookmarkMarkup(node: BookmarkNode): string {
  const url = node.url as string
  const title = node.title.trim() || url
  const host = hostnameOf(url) ?? url
  return `
    <a class="bookmark" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener"
       data-search="${escapeHtml(`${title} ${host}`.toLowerCase())}">
      ${tileMarkup(title, url, FAVICON_BASE)}
      <span class="bookmark__main">
        <span class="bookmark__title">${escapeHtml(title)}</span>
        <span class="bookmark__host">${escapeHtml(host)}</span>
      </span>
    </a>
  `
}

function sectionMarkup(title: string, nodes: readonly BookmarkNode[]): string {
  if (nodes.length === 0) return ''
  return `
    <section class="section">
      <div class="section__head">
        <h2 class="section__title">${escapeHtml(title)}</h2>
        <span class="badge">${nodes.length}</span>
      </div>
      <div class="grid">${nodes.map(bookmarkMarkup).join('')}</div>
    </section>
  `
}

function folderHref(folderId: string): string {
  return `folder.html?id=${encodeURIComponent(folderId)}`
}

function subfolderCardMarkup(folder: BookmarkNode): string {
  const bookmarks = (folder.children ?? []).filter((child) => child.url)
  const folderCount = (folder.children ?? []).filter((child) => !child.url).length
  return `
    <a class="bookmark" href="${escapeHtml(folderHref(folder.id))}">
      <span class="tile" style="--tile-hue:236"><span class="tile__text">▸</span></span>
      <span class="bookmark__main">
        <span class="bookmark__title">${escapeHtml(folder.title)}</span>
        <span class="bookmark__host">${bookmarks.length} 个书签${
          folderCount > 0 ? ` · ${folderCount} 个子文件夹` : ''
        }</span>
      </span>
    </a>
  `
}

async function render(): Promise<void> {
  const root = q<HTMLDivElement>('#root')
  const folderId = new URLSearchParams(location.search).get('id')

  if (!folderId) {
    root.innerHTML = '<main class="app"><p class="empty">缺少文件夹参数，请从 TabFurl 主界面打开。</p></main>'
    return
  }

  const folder = await getSubTree(folderId)
  if (!folder) {
    root.innerHTML = '<main class="app"><p class="empty">找不到该收藏文件夹，可能已被删除。</p></main>'
    return
  }

  const children = folder.children ?? []
  const looseBookmarks = children.filter((child) => child.url)
  const subFolders = children.filter((child) => !child.url)
  const totalBookmarks = looseBookmarks.length +
    subFolders.reduce(
      (sum, sub) => sum + (sub.children ?? []).filter((item) => item.url).length,
      0
    )

  const crumbs = await getNodePath(folderId)
  const crumbMarkup = crumbs
    .slice(0, -1)
    .map((title) => `<span>${escapeHtml(title)}</span>`)
    .join('<span> / </span>')

  const isEmpty = subFolders.length === 0 && looseBookmarks.length === 0

  document.title = `${folder.title} · TabFurl`

  root.innerHTML = `
    <main class="app">
      <header class="app__header">
        <h1 class="app__title">${escapeHtml(folder.title)}</h1>
        <p class="crumbs">${crumbMarkup ? `${crumbMarkup}<span> / </span>` : ''}<span>${escapeHtml(
          folder.title
        )}</span></p>
        <p class="muted" id="count-hint">${subFolders.length} 个子文件夹 · ${totalBookmarks} 个书签</p>
      </header>

      <div class="row">
        <input type="search" class="input" id="search" placeholder="在本文件夹内搜索…"
               autocomplete="off" style="max-width:280px" />
        <button type="button" class="btn" id="open-window-btn">按子文件夹还原为窗口</button>
        <span class="status" id="status"></span>
      </div>

      ${
        subFolders.length > 0
          ? `<section class="section">
               <div class="section__head">
                 <h2 class="section__title">子文件夹</h2>
                 <span class="badge">${subFolders.length}</span>
               </div>
               <div class="grid">${subFolders.map(subfolderCardMarkup).join('')}</div>
             </section>`
          : ''
      }

      ${sectionMarkup('未归入子文件夹', looseBookmarks)}

      ${isEmpty ? '<p class="empty">这个文件夹是空的。</p>' : ''}
    </main>
  `

  const searchInput = q<HTMLInputElement>('#search')
  const status = q<HTMLSpanElement>('#status')
  const openWindowButton = q<HTMLButtonElement>('#open-window-btn')

  decorateTiles(root)

  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim().toLowerCase()
    for (const element of document.querySelectorAll<HTMLElement>('.bookmark[data-search]')) {
      element.hidden = term.length > 0 && !(element.dataset.search ?? '').includes(term)
    }
  })

  openWindowButton.addEventListener('click', async () => {
    openWindowButton.disabled = true
    try {
      const settings = await loadSettings()
      const result = await restoreFolder(folderId, {target: settings.restoreTarget})
      status.className = 'status status--ok'
      status.textContent = `已打开 ${result.opened} 个标签页，创建 ${result.groups} 个分组`
    } catch (error) {
      status.className = 'status status--error'
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      openWindowButton.disabled = false
    }
  })
}

void render()
