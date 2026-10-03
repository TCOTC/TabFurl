import {listBookmarkBarFolders} from '../shared/bookmarks'
import {escapeHtml} from '../shared/tile'
import {errorText, q} from './dom'
import {FOLDER_ICON} from './icons'

/**
 * 一次最多渲染多少行。真实数据里书签栏下有几百分文件夹（实测 800+），全画出来没意义。
 * 超出的不渲染，但**用一行说明如实写出来**：「只剩这些」与「还有更多没显示」是两回事。
 */
const MAX_ROWS = 200

const TEMPLATE = (prefix: string): string => `
  <div class="picker" id="${prefix}-folder-picker" hidden>
    <input type="search" class="input input--sm picker__search" id="${prefix}-folder-picker-search"
           placeholder="搜索文件夹…" autocomplete="off" spellcheck="false"
           aria-label="搜索文件夹" aria-controls="${prefix}-folder-picker-list" />
    <ul class="picker__list" id="${prefix}-folder-picker-list"></ul>
    <p class="picker__note" id="${prefix}-folder-picker-note" hidden></p>
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
 * 可搜索的文件夹选择器，取代了原生 `<select>`：候选是**完整路径**，几百个选项叠在下拉框里既看不全
 * 也不好找（原生不能打字过滤、也不显示层级），而用户的真实需要是「打几个字缩到两三行」。
 *
 * 三条要点：**打开时才读候选**（刚建的文件夹进来就是最新的，且这个动作本身就是用户主动点的，
 * 读一次远比「看不到刚建的」划算）；**光标先落在搜索框**且 ↓/↑/Enter 能跑（键盘可以一气打完）；
 * **已收藏的层列出来但不可点**（而不是让用户点了之后收到一句「已经在收藏里了」）。
 * 候选读不出来时（书签栏认不出）在面板里写原因，**不留下一个静默失败**。
 */
export function createFolderPicker(options: {
  /** id 前缀：两条 chip 栏各有一个选择器，而它们住在同一份 DOM 里。 */
  idPrefix: string
  /** 已经收藏过的层。 */
  isFavorited(id: string): boolean
  /** 用户选中了一层。 */
  onPick(id: string): void
}): FolderPicker {
  const element = document.createElement('div')
  element.className = 'picker-host'
  element.innerHTML = TEMPLATE(options.idPrefix)

  const panel = q<HTMLElement>(element, `#${options.idPrefix}-folder-picker`)
  const search = q<HTMLInputElement>(element, `#${options.idPrefix}-folder-picker-search`)
  const list = q<HTMLUListElement>(element, `#${options.idPrefix}-folder-picker-list`)
  const note = q<HTMLParagraphElement>(element, `#${options.idPrefix}-folder-picker-note`)

  let entries: Entry[] = []
  let rows: HTMLButtonElement[] = []
  let active = -1
  let trigger: HTMLElement | undefined
  /** `showModal()` 那类 API 会抛，但这里不用它；这个闩只是让「重复点」不会叠加监听器。 */
  let open = false
  /**
   * 输入法正在合成（中文 / 日文这类要选字的输入）。合成期间 `input` 会带着**未选定的拼音**连着触发
   *（打「工具」先来 `g`、`go`、`gon`…），拿它们过滤只会让候选一瞬间被筛空再跳回来
   * → 合成期间不重绘，等 `compositionend` 再按最终文字筛一次。
   * 只用 `isComposing` 不行：`compositionend` 之后那个 `input` 里它已是 `false`，而顺序并不可靠。
   */
  let composing = false

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
    // `bounded` 一定落在范围内（上面已挡掉空表），这个守卫只是把那个前提写给类型看。
    const row = rows[bounded]
    if (!row) return
    rows[active]?.classList.remove('is-active')
    active = bounded
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
    try {
      entries = await loadEntries()
    } catch (error) {
      // 读不到书签栏（`getBookmarksBarId()` 认不出 id `1` 会抛）——比如书签树还没加载好。
      // 不接住的话这里是个未捕获的 Promise 拒绝：面板不开，用户看到的是「点了＋没反应」。
      entries = []
      list.innerHTML = ''
      note.hidden = false
      note.textContent = `读不到书签栏：${errorText(error)}`
      panel.hidden = false
      open = true
      document.addEventListener('pointerdown', onPointerDown, true)
      return
    }
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

  search.addEventListener('input', () => {
    // 合成中的字母不是用户要搜的东西（见 `composing`）。
    if (composing) return
    render()
  })

  // 合成结束再筛一次：此时 `search.value` 已经是选定的那几个字。
  search.addEventListener('compositionstart', () => {
    composing = true
  })
  search.addEventListener('compositionend', () => {
    composing = false
    render()
  })

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
