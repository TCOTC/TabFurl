import {getNodePath, getSubTree} from '../src/shared/bookmarks'
import {restoreFolder} from '../src/shared/restore'
import {loadSettings} from '../src/shared/settings'
import {escapeHtml, faviconMarkup} from '../src/shared/tile'
import type {BookmarkNode} from '../src/shared/types'
import {hostnameOf} from '../src/shared/urls'
import '../src/shared/base.css'
import './folder.css'

/** Chrome 本地 favicon 缓存端点：读缓存、不联网（配合 `faviconMarkup` 使用）。 */
const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

/**
 * 子文件夹卡片上的图标。
 *
 * 之前用的是 `▸`，那是**展开/折叠**的指示符，而这里的卡片是个链接（点进去看内容），
 * 语义对不上。改用内联 SVG 而不是 emoji：emoji 各平台配色不一，而这个要跟着主题走
 * （`currentColor` 会继承 `.folder-tile` 的前景色）。
 */
const FOLDER_ICON = `
  <svg class="folder-tile__icon" viewBox="0 0 16 16">
    <path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h2.6a1 1 0 0 1 .8.4l.9 1.2h5.2A1.5 1.5 0 0 1 14.25 6.1v5.4A1.5 1.5 0 0 1 12.75 13H3.25A1.5 1.5 0 0 1 1.75 11.5Z"
          fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
  </svg>
`

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
      ${faviconMarkup(url, FAVICON_BASE)}
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
      <span class="folder-tile" aria-hidden="true">${FOLDER_ICON}</span>
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

  // 面包屑：除当前这一层外都可点，点了就打开那一层文件夹。
  // 当前层是这一页自身，做成链接只是噪声，所以留作纯文本。
  const path = await getNodePath(folderId)
  const ancestors = path.slice(0, -1)
  const crumbMarkup = ancestors
    .map((node) => `<a href="${escapeHtml(folderHref(node.id))}">${escapeHtml(node.title)}</a>`)
    .join('<span> / </span>')

  const isEmpty = subFolders.length === 0 && looseBookmarks.length === 0

  // 当前层的标题也走同一套兜底（`getNodePath` 会给空标题补「书签」）。
  // 书签树的根节点标题就是空串，而它在面包屑里是可点的，所以这里必须一致——
  // 否则点进根之后 h1 与面包屑会双双变成空白。
  const currentTitle = path.at(-1)?.title ?? folder.title

  document.title = `${currentTitle} · TabFurl`

  root.innerHTML = `
    <main class="app">
      <header class="app__header">
        <h1 class="app__title">${escapeHtml(currentTitle)}</h1>
        <p class="crumbs">${crumbMarkup ? `${crumbMarkup}<span> / </span>` : ''}<span>${escapeHtml(
          currentTitle
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

  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim().toLowerCase()
    for (const element of document.querySelectorAll<HTMLElement>('.bookmark[data-search]')) {
      element.hidden = term.length > 0 && !(element.dataset.search ?? '').includes(term)
    }
  })

  openWindowButton.addEventListener('click', async () => {
    openWindowButton.disabled = true
    // 这一句必须留：舍弃前要等导航提交（最多 2 秒），没有它界面看起来就是卡住的。
    status.className = 'status status--ok'
    status.textContent = '正在打开…'
    try {
      const settings = await loadSettings()
      await restoreFolder(folderId, {target: settings.restoreTarget})
      // 成功不留报账式提示：窗口已经打开，看得见。
      status.className = 'status'
      status.textContent = ''
    } catch (error) {
      status.className = 'status status--error'
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      openWindowButton.disabled = false
    }
  })
}

void render()
