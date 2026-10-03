import {listBookmarkBarFolders} from '../shared/bookmarks'
import {escapeHtml} from '../shared/tile'
import {q} from './dom'
import {FOLDER_ICON} from './icons'

/**
 * 一次最多渲染多少行。
 *
 * 真实数据里书签栏下有几百个文件夹（实测 800+），全画出来没有意义：用户看不见那么多，
 * 而输入几个字就能缩到几十行。超出的部分不渲染，但**用一行说明如实写出来**——
 * 「只剩这些」与「还有更多没显示」是两回事，不能让用户以为已经到底了。
 */
const MAX_ROWS = 200

const TEMPLATE = `
  <div class="picker" id="folder-picker" hidden>
    <input type="search" class="input input--sm picker__search" id="folder-picker-search"
           placeholder="搜索文件夹…" autocomplete="off" spellcheck="false"
           aria-label="搜索文件夹" aria-controls="folder-picker-list" />
    <ul class="picker__list" id="folder-picker-list"></ul>
    <p class="picker__note" id="folder-picker-note" hidden></p>
  </div>
`

interface Entry {
  id: string
  title: string
  /** 显示用的完整路径（含书签栏），搜索也匹配它。 */
  path: string
}

export interface FolderPicker {
  /** 面板本身；由调用方插进 DOM（它自己找一个能被裁切的位置）。 */
  readonly element: HTMLElement
  /** 打开（已开着则关掉）。`trigger` 用来做「点它不算点外面」与关闭后的焦点归还。 */
  toggle(trigger: HTMLElement): Promise<void>
  close(): void
}

/**
 * 可搜索的文件夹选择器。
 *
 * 它取代了原来那个原生 `<select>`：候选是**完整路径**，几百个选项叠在一个下拉框里既看不全
 * 也不好找（原生下拉框不能打字过滤、也不显示层级），而用户的真实需要是「打几个字把它缩到两三行」。
 *
 * 做成独立组件（而不是塞在 chip 栏里）有三个理由：
 * - 它自己有状态（搜索词、当前高亮项、候选缓存），与 chip 的排序互不相干；
 * - 面板要能遮住下面的列表，所以必须在结构上与那一行分开；
 * - 将来别处要用同一个「挑一层文件夹」的交互时，直接复用，不用再抄一遍。
 *
 * 三条实现要点：
 * - **打开时才读候选**，所以刚在书签管理器里新建的文件夹进来就是最新的；不缓存，
 *   因为这个动作本身就是用户主动点的，读一次书签树的代价远小于「看不到刚建的文件夹」的困惑。
 * - **光标一开始就在搜索框里**，并且 ↓/↑/Enter 能在候选里走——键盘可以直接完成「打字 → 选中」。
 * - **已经收藏过的层列出来但标记成不可点**（带一个「已收藏」），而不是让用户点了之后
 *   收到一句「已经在收藏里了」。
 */
export function createFolderPicker(options: {
  /** 已经收藏过的层。 */
  isFavorited(id: string): boolean
  /** 用户选中了一层。 */
  onPick(id: string): void
}): FolderPicker {
  const element = document.createElement('div')
  element.className = 'picker-host'
  element.innerHTML = TEMPLATE

  const panel = q<HTMLElement>(element, '#folder-picker')
  const search = q<HTMLInputElement>(element, '#folder-picker-search')
  const list = q<HTMLUListElement>(element, '#folder-picker-list')
  const note = q<HTMLParagraphElement>(element, '#folder-picker-note')

  let entries: Entry[] = []
  let rows: HTMLButtonElement[] = []
  let active = -1
  let trigger: HTMLElement | undefined
  /** `showModal()` 那类 API 会抛，但这里不用它；这个闩只是让「重复点」不会叠加监听器。 */
  let open = false

  function isOpen(): boolean {
    return open
  }

  /** 画当前搜索词命中的那些行。 */
  function render(): void {
    const query = search.value.trim().toLowerCase()
    const matched = query ? entries.filter((entry) => entry.path.toLowerCase().includes(query)) : entries
    const shown = matched.slice(0, MAX_ROWS)

    if (shown.length === 0) {
      list.innerHTML = `<li class="picker__empty">没有匹配「${escapeHtml(search.value.trim())}」的文件夹。</li>`
      rows = []
    } else {
      list.innerHTML = shown
        .map((entry) => {
          const favorited = options.isFavorited(entry.id)
          const marker = favorited
            ? '<span class="picker__flag">已收藏</span>'
            : ''
          return `
            <li>
              <button type="button" class="item picker__row" data-pick="${escapeHtml(entry.id)}"
                      ${favorited ? 'disabled' : ''}>
                <span class="folder-tile" aria-hidden="true">${FOLDER_ICON}</span>
                <span class="item__main">
                  <span class="item__title">${escapeHtml(entry.title)}</span>
                  <span class="item__meta">${escapeHtml(entry.path)}</span>
                </span>
                ${marker}
              </button>
            </li>`
        })
        .join('')
      rows = [...list.querySelectorAll<HTMLButtonElement>('.picker__row')]
    }

    note.hidden = matched.length <= MAX_ROWS
    note.textContent = `只显示前 ${MAX_ROWS} 项，还有 ${matched.length - MAX_ROWS} 项——继续输入可以缩小范围。`
    active = -1
  }

  function highlight(next: number): void {
    if (rows.length === 0) return
    const bounded = (next + rows.length) % rows.length
    rows[active]?.classList.remove('is-active')
    active = bounded
    const row = rows[active]
    row.classList.add('is-active')
    row.scrollIntoView({block: 'nearest'})
  }

  function close(restoreFocus = true): void {
    if (!open) return
    open = false
    panel.hidden = true
    document.removeEventListener('pointerdown', onPointerDown, true)
    if (restoreFocus) trigger?.focus()
  }

  /**
   * 点面板外面就关掉。
   *
   * 触发按钮本身要排除在外：否则「再点一次关掉」会变成「关掉又立刻打开」
   * （pointerdown 先关，紧接着 click 又 toggle 开）。
   */
  function onPointerDown(event: PointerEvent): void {
    const target = event.target as Node
    if (panel.contains(target) || trigger?.contains(target)) return
    close(false)
  }

  async function toggle(button: HTMLElement): Promise<void> {
    if (isOpen()) {
      close()
      return
    }
    trigger = button
    entries = await loadEntries()
    search.value = ''
    render()
    panel.hidden = false
    open = true
    document.addEventListener('pointerdown', onPointerDown, true)
    search.focus()
  }

  async function loadEntries(): Promise<Entry[]> {
    const {barTitle, folders} = await listBookmarkBarFolders()
    return folders.map((folder, index) => ({
      id: folder.id,
      title: folder.title,
      // 第一项是书签栏自身：它的 path 是空的，所以写一句说明，而不是显示成一片空白。
      path: index === 0 ? `${folder.title}（书签栏自身）` : [barTitle, ...folder.path, folder.title].join(' / ')
    }))
  }

  search.addEventListener('input', () => render())

  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      highlight(active + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      highlight(active - 1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = rows[active]
      if (row?.dataset.pick) pick(row.dataset.pick)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  // 行的键盘可达性：Tab 到某一行之后按 Enter 也能选，所以键盘事件也挂在列表上。
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  list.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-pick]')
    if (row?.dataset.pick) pick(row.dataset.pick)
  })

  function pick(id: string): void {
    options.onPick(id)
    close()
  }

  return {element, toggle, close}
}
