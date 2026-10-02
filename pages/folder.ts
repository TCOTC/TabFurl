import {getNodePath, getSubTree} from '../src/shared/bookmarks'
import {restoreFolder} from '../src/shared/restore'
import {escapeHtml, faviconMarkup} from '../src/shared/tile'
import type {BookmarkNode, RestoreOptions} from '../src/shared/types'
import {hostnameOf, isSeparatorUrl, separatorTitle} from '../src/shared/urls'
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

/**
 * 分隔线（Maya Studios 约定的那个占位书签）。
 *
 * 它不是书签，而是书签树里的一个组织记号，所以画成一条横线：标题为空就只画线，
 * 标题非空时把标题嵌在线的正中（两边各一段线，构成「—— 标题 ——」）。
 *
 * `data-search` 也给它一份：搜索时它会跟着被藏起来，列表就被压平了——
 * 无标题的分隔线永远匹配不上任何词，正是想要的效果。
 *
 * 标题首尾手画的横杠会先剥掉（见 `separatorTitle`）：那个位置已经有一条真线了。
 */
function separatorMarkup(node: BookmarkNode): string {
  const title = separatorTitle(node.title)
  if (!title) return '<hr class="separator separator--plain" data-search="" />'
  return `
    <div class="separator" role="separator" aria-orientation="horizontal"
         data-search="${escapeHtml(title.toLowerCase())}">
      <span class="separator__title">${escapeHtml(title)}</span>
    </div>
  `
}

/** 是书签就画卡片，是分隔线就画横线；顺序即书签树里的顺序。 */
function entryMarkup(node: BookmarkNode): string {
  return isSeparatorUrl(node.url) ? separatorMarkup(node) : bookmarkMarkup(node)
}

function sectionMarkup(title: string, nodes: readonly BookmarkNode[]): string {
  if (nodes.length === 0) return ''
  // 胸章只数真书签：分隔线不是书签，算进去会与下面的「N 个书签」对不上。
  const count = nodes.filter((node) => !isSeparatorUrl(node.url)).length
  return `
    <section class="section">
      <div class="section__head">
        <h2 class="section__title">${escapeHtml(title)}</h2>
        <span class="badge">${count}</span>
      </div>
      <div class="grid">${nodes.map(entryMarkup).join('')}</div>
    </section>
  `
}

function folderHref(folderId: string): string {
  return `folder.html?id=${encodeURIComponent(folderId)}`
}

function subfolderCardMarkup(folder: BookmarkNode): string {
  const bookmarks = (folder.children ?? []).filter(
    (child) => child.url && !isSeparatorUrl(child.url)
  )
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
  // 兜底成空串而不是留着 undefined：`runRestore` 是嵌套函数，在那里面 TS 会丢掉
  // 外面那个守卫对 `string | null` 的收窄。
  const folderId = new URLSearchParams(location.search).get('id') ?? ''

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
  // 分隔线留在这个列表里，好让它在原位被画出来（见 `entryMarkup`）。
  const looseBookmarks = children.filter((child) => child.url)
  const subFolders = children.filter((child) => !child.url)
  const countBookmarks = (nodes: readonly BookmarkNode[]): number =>
    nodes.filter((node) => node.url && !isSeparatorUrl(node.url)).length
  const totalBookmarks = countBookmarks(looseBookmarks) +
    subFolders.reduce((sum, sub) => sum + countBookmarks(sub.children ?? []), 0)

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
        <button type="button" class="btn" id="open-new-window-btn">还原到新窗口</button>
        <button type="button" class="btn" id="open-current-window-btn">还原到当前窗口</button>
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
  const openNewWindowButton = q<HTMLButtonElement>('#open-new-window-btn')
  const openCurrentWindowButton = q<HTMLButtonElement>('#open-current-window-btn')

  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim().toLowerCase()
    // 分隔线也带 `data-search`，所以会一并被筛掉；否则搜索时线会孤零零留在列表里。
    for (const element of document.querySelectorAll<HTMLElement>('[data-search]')) {
      element.hidden = term.length > 0 && !(element.dataset.search ?? '').includes(term)
    }
  })

  /**
   * 还原这个文件夹。
   *
   * 去向由按钮直接决定（新窗口 / 当前窗口），不存全局偏好：它是「这一次要开到哪里」，
   * 同一个文件夹两次可能选得不一样。
   */
  async function runRestore(target: RestoreOptions['target']): Promise<void> {
    openNewWindowButton.disabled = true
    openCurrentWindowButton.disabled = true
    // 这一句必须留：舍弃前要等导航提交（最多 2 秒），没有它界面看起来就是卡住的。
    status.className = 'status status--ok'
    status.textContent = '正在打开…'
    try {
      await restoreFolder(folderId, {target})
      // 成功不留报账式提示：窗口已经打开，看得见。
      status.className = 'status'
      status.textContent = ''
    } catch (error) {
      status.className = 'status status--error'
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      openNewWindowButton.disabled = false
      openCurrentWindowButton.disabled = false
    }
  }

  openNewWindowButton.addEventListener('click', () => void runRestore('newWindow'))
  openCurrentWindowButton.addEventListener('click', () => void runRestore('currentWindow'))
}

void render()
