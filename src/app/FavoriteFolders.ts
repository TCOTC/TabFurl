import {getBookmarksBarId, getNodePath} from '../shared/bookmarks'
import {loadSettings, updateSettings} from '../shared/settings'
import {escapeHtml} from '../shared/tile'
import {errorText, q, setStatus, type AppEvents} from './dom'
import {createFolderPicker, type FolderPicker} from './FolderPicker'
import {STAR_ICON, plusIcon} from './icons'

/**
 * chip 的拖动载荷类型。
 *
 * chip 的拖动只在**这一条 chip 栏内部**有意义（排序），所以它不写 `text/uri-list`、
 * 也不写面板那个 `application/x-tabfurl`——那两个类型一出现，两栏的落点判定就会把它当成
 * 「从网页拖来的链接」或「一条标签」。用一个自己的类型，别处谁都不认，只有这里认。
 */
const CHIP_DRAG_TYPE = 'application/x-tabfurl-favorite'

/** 一块 chip 栏属于哪一栏。它决定「收藏这一层」读谁、跳转发给谁。 */
export type PaneSide = 'left' | 'right'

/** 一个收藏。只有 id 是存储里的，标题与路径每次现读（书签可以改名、可以被挪走）。 */
export interface FavoriteEntry {
  id: string
  title: string
  path: string
}

/**
 * 收藏文件夹的**状态**：哪几层、什么顺序。
 *
 * 它是个**独立于界面**的东西，因为 F7 之后两栏各有一条 chip 栏，而它们说的是同一件事
 * （同一份收藏、同一个顺序）——只是各自标出「我正站在哪」而已。
 * 所以状态只能有一份：两个视图各存一份的话，在一边排序、另一边不动，两边就会开始说不同的话。
 *
 * 它不碰 DOM，只负责读写存储并**叫一声**（`subscribe`），重画交给视图。
 */
export interface FavoriteStore {
  /** 当前收藏（已按顺序）。 */
  entries(): readonly FavoriteEntry[]
  /** 已收藏的 id 集合，给选择器标「已收藏」用。 */
  favorited(): ReadonlySet<string>
  /** 上一次读数据失败的原因（例如认不出书签栏）。两块视图都要把它显示出来。 */
  loadError(): string | undefined
  /** 重读存储、自愈失效项、通知视图。 */
  load(): Promise<void>
  /** 加一个收藏。失败时抛出（消息直接可展示）。 */
  add(folderId: string): Promise<void>
  /** 取消收藏。 */
  remove(folderId: string): Promise<void>
  /** 按新顺序落盘（拖动排序的落点）。 */
  reorder(ids: readonly string[]): Promise<void>
  /** 状态变了就叫一声；两块视图各自重画。 */
  subscribe(listener: () => void): void
}

/**
 * 建那份唯一的收藏状态。四条约定：
 * **顺序即数组顺序、第一个就是打开界面时的落点**（所以支持拖拽排序）；
 * **加收藏两个入口**（☆ 本栏当前层 / ＋ 选择器挑一层）都走同一个 `add()`，去重与落盘只有一份；
 * **只能收藏书签栏里的层**（扩展不往「其他书签」写东西）；
 * **一个收藏都不可用时由面板退回书签栏**（不是这里的事）——这里只保证空栏看着不像坏了。
 */
export function createFavoriteStore(events: AppEvents): FavoriteStore {
  let entries: FavoriteEntry[] = []
  let favorited = new Set<string>()
  let loadError: string | undefined
  const listeners: (() => void)[] = []

  function notify(): void {
    for (const listener of listeners) listener()
  }

  /**
   * 存储里的 id，顺手把失效的剔掉。书签 id 是设备本地的：同步到另一台设备、或用户手删了文件夹之后，
   * 设置里那份就可能指向不存在的东西。这里做一次自愈，且**只在真的丢掉时**才落盘。
   */
  async function liveIds(): Promise<string[]> {
    const stored = (await loadSettings()).favoriteFolderIds
    const alive: string[] = []
    for (const id of stored) {
      if ((await getNodePath(id)).length > 0) alive.push(id)
    }
    if (alive.length !== stored.length) await updateSettings({favoriteFolderIds: alive})
    return alive
  }

  async function load(): Promise<void> {
    try {
      const ids = await liveIds()
      const next: FavoriteEntry[] = []
      for (const id of ids) {
        const path = await getNodePath(id)
        next.push({
          id,
          title: path.at(-1)?.title ?? '',
          path: path.map((node) => node.title).join(' / ')
        })
      }
      entries = next
      favorited = new Set(next.map((entry) => entry.id))
      loadError = undefined
    } catch (error) {
      // 认不出书签栏时选择器也拉不到候选，把原因写出来，而不是留一堆空控件让人猜。
      entries = []
      favorited = new Set()
      loadError = errorText(error)
    }
    notify()
  }

  return {
    entries: () => entries,
    favorited: () => favorited,
    loadError: () => loadError,
    load,
    async add(folderId) {
      const stored = (await loadSettings()).favoriteFolderIds
      if (stored.includes(folderId)) throw new Error('已经在收藏里了。')
      await updateSettings({favoriteFolderIds: [...stored, folderId]})
      await events.favoritesChanged()
    },
    async remove(folderId) {
      const stored = (await loadSettings()).favoriteFolderIds
      await updateSettings({favoriteFolderIds: stored.filter((id) => id !== folderId)})
      await events.favoritesChanged()
    },
    async reorder(ids) {
      await updateSettings({favoriteFolderIds: [...ids]})
      await events.favoritesChanged()
    },
    subscribe(listener) {
      listeners.push(listener)
    }
  }
}

/**
 * 一条 chip 栏：取代了早期的「默认展示文件夹」下拉框（那个只有一个值，还暗示「只能在这一个文件夹里写」，
 * 而收藏只是**快捷方式**、不是边界）。
 *
 * 两栏各有一条（F7），但渲染的是 `store` 里**同一份数据**——在这一条上排序，另一条跟着变。
 * 各自不同的只有「我这一栏正站在哪」（`currentFolderId`）。两条路（☆ 与 ＋）都走 `store.add()`。
 */
export interface FavoriteBar {
  readonly element: HTMLElement
}

export function createFavoriteBar(
  store: FavoriteStore,
  events: AppEvents,
  side: PaneSide,
  currentFolderId: () => string
): FavoriteBar {
  const element = document.createElement('div')
  element.className = 'favs-bar'

  // 两栏各有一条、又住在同一份 DOM 里：id 必须分开，否则 `getElementById` 与 `aria-*` 引用
  // 都会指向先出现的那一条。
  const id = (suffix: string): string => `${side === 'left' ? 'left-fav' : 'fav'}-${suffix}`
  element.innerHTML = `
    <div class="favs" id="${id('list')}" role="list" aria-label="收藏的文件夹"></div>
    <!--
      两个**只有图标**的按钮：文案写在 title / aria-label 上。
      这一行是「常去的那几层」的快捷栏，chip 才是主角；两个带文字的按钮（尤其「＋ 添加收藏…」）
      加起来能占掉半行，把 chip 挤到看不见——而它们一个是「收藏本栏这一层」、一个是「从书签栏挑」，
      悬停一下就知道，不值得常驻半行文字。
    -->
    <button type="button" class="btn btn--ghost btn--icon" id="${id('add-current')}"
            title="收藏本栏当前这一层" aria-label="收藏本栏当前这一层">${STAR_ICON}</button>
    <button type="button" class="btn btn--ghost btn--icon" id="${id('add-pick')}"
            title="从书签栏里挑一层收藏" aria-label="从书签栏里挑一层收藏">${plusIcon()}</button>
    <p class="status" id="${id('status')}" hidden></p>
  `

  const list = q<HTMLDivElement>(element, `#${id('list')}`)
  const starButton = q<HTMLButtonElement>(element, `#${id('add-current')}`)
  const plusButton = q<HTMLButtonElement>(element, `#${id('add-pick')}`)
  const status = q<HTMLParagraphElement>(element, `#${id('status')}`)

  /**
   * 选择器是**独立组件**（`FolderPicker.ts`）：它有自己的搜索词与高亮项状态，
   * 还要能遮住下面的列表，所以不塞在这一行里，只把它的元素挂进来。
   */
  const picker: FolderPicker = createFolderPicker({
    // 两条 chip 栏各有一个选择器，而它们住在同一份 DOM 里：id 得分开
    // （重复 id 会让 `aria-controls` 指到先出现的那一个）。
    idPrefix: side === 'left' ? 'left-fav' : 'fav',
    isFavorited: (folderId) => store.favorited().has(folderId),
    onPick: (folderId) => void add(folderId)
  })
  element.append(picker.element)

  /**
   * 这一条 chip 栏上一次的签名。
   *
   * 初值是 `undefined`（还没渲染过），**不能是空串**：一个收藏都没有的时候签名同样是空串，
   * 两者一撞，「第一次就该画出空态提示」这一步会被当成「内容没变」跳过。
   * 拖动期间会改 DOM，落盘后刷新时也靠它判断要不要重建。
   */
  let lastChips: string | undefined
  /** 上一次渲染出来的 id 顺序，用来判断拖完之后是否真的要落盘。 */
  let lastOrder: string | undefined
  let dragging: HTMLElement | undefined

  /** 当前这一层是不是在书签栏里。 */
  async function inBar(path: readonly {id: string}[]): Promise<boolean> {
    try {
      // getNodePath 的形状是 [根, 书签栏 / 其他书签 / … , …, 自身]，所以第二项就说明它属于哪个内置目录。
      return path[1]?.id === (await getBookmarksBarId())
    } catch {
      return false
    }
  }

  async function add(folderId: string): Promise<void> {
    try {
      await store.add(folderId)
      setStatus(status, '已加入收藏。', 'ok')
    } catch (error) {
      setStatus(status, errorText(error), 'error')
    }
  }

  async function remove(folderId: string): Promise<void> {
    try {
      await store.remove(folderId)
      setStatus(status, '已取消收藏。', 'ok')
    } catch (error) {
      setStatus(status, `取消失败：${errorText(error)}`, 'error')
    }
  }

  /** 「☆ 收藏这一层」：条件不满足时说清原因，而不是给一个灰按钮让人猜。 */
  async function addCurrent(): Promise<void> {
    const folderId = currentFolderId()
    if (!folderId) {
      setStatus(status, '这一栏还没落到任何一层。', 'error')
      return
    }
    const path = await getNodePath(folderId)
    if (path.length === 0) {
      setStatus(status, '这一层已经不在了。', 'error')
      return
    }
    // 路径只有一层 = 它就是书签树的根（`书签栏` / `其他书签` / `移动设备书签` 都带一层父）。
    // 这一条要单独判，否则它会被下面那条说成「扩展不往其他书签里写」——原因其实不一样。
    if (path.length < 2) {
      setStatus(status, '这里是书签树的根，它本身不是文件夹，没法收藏。', 'error')
      return
    }
    if (!(await inBar(path))) {
      setStatus(status, '只能收藏书签栏里的文件夹（扩展不往其他书签里写）。', 'error')
      return
    }
    await add(folderId)
  }

  function renderChips(entries: readonly FavoriteEntry[]): void {
    // 两处签名都用 `JSON.stringify` 拼，**不自己定分隔符**（见 `AGENTS.md` 第 27 条）：
    // 手写分隔符隐含「内容里不会出现这个字符」，而文件夹名里什么字符都可能有。
    const signature = JSON.stringify(entries.map((entry) => [entry.id, entry.title]))
    if (signature === lastChips) return
    lastChips = signature
    // `lastOrder` 必须与 `persistOrder()` 里的比较**用同一种拼法**，否则那个守卫永远不成立
    //（每次拖动结束都会白白写一次存储）。两边都从这一份 id 数组算出。
    lastOrder = JSON.stringify(entries.map((entry) => entry.id))

    if (entries.length === 0) {
      // 提示要短：它与两个入口同行，而一栏在窄窗口下只有四百来像素，
      // 一句话写满就会换行、把整条栏抬高（实测写「…用右边两个入口加一个」时会变成两行）。
      list.innerHTML = '<span class="favs__empty">还没有收藏。</span>'
      return
    }

    list.innerHTML = entries
      .map(
        (entry) => `
        <span class="chip" draggable="true" data-chip="${escapeHtml(entry.id)}"
              title="${escapeHtml(entry.path)}">
          <button type="button" class="chip__go" data-goto-chip="${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</button>
          <button type="button" class="chip__x" data-remove-chip="${escapeHtml(entry.id)}"
                  title="不再收藏">×</button>
        </span>`
      )
      .join('')
  }

  /** 从状态里重画这一条（状态变了、或拖动落盘之后）。 */
  function render(): void {
    const failure = store.loadError()
    renderChips(store.entries())
    if (failure) setStatus(status, failure, 'error')
  }

  /**
   * 把 chip 栏当前顺序落盘。依据是 **DOM 里现在的顺序**（拖动期间就把元素真的插到了新位置），
   * 而不是另算一份下标——那份会与视觉分叉。与已渲染的顺序一样就不写存储。
   * 落盘后 `store` 会通知**两条**视图重画，另一边跟着换顺序。
   */
  async function persistOrder(): Promise<void> {
    const ids = [...list.querySelectorAll<HTMLElement>('[data-chip]')].map(
      (chip) => chip.dataset.chip as string
    )
    if (ids.length === 0 || JSON.stringify(ids) === lastOrder) return
    try {
      await store.reorder(ids)
    } catch (error) {
      setStatus(status, `保存顺序失败：${errorText(error)}`, 'error')
    }
  }

  store.subscribe(() => {
    // 重画之前先清掉上一句提示（拖动排序这类动作的消息归自己管，状态这边的错误会重新写）。
    setStatus(status, '', 'ok')
    render()
  })

  // ———————————————— 交互 ————————————————

  element.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const removeButton = target.closest<HTMLButtonElement>('[data-remove-chip]')
    if (removeButton?.dataset.removeChip) {
      void remove(removeButton.dataset.removeChip)
      return
    }

    const goButton = target.closest<HTMLButtonElement>('[data-goto-chip]')
    if (goButton?.dataset.gotoChip) {
      // 「跳过去」是**意图**：跳哪一栏由 `App` 转给面板（导航归面板所有）。
      void events.folderChosen(goButton.dataset.gotoChip, side)
      return
    }

    if (target.closest(`#${id('add-current')}`)) void addCurrent()
    if (target.closest(`#${id('add-pick')}`)) void picker.toggle(plusButton)
  })

  list.addEventListener('dragstart', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-chip]')
    if (!chip || !event.dataTransfer) return
    dragging = chip
    event.dataTransfer.effectAllowed = 'move'
    // 必须写点东西，否则某些浏览器的拖动根本不会真正开始。
    event.dataTransfer.setData(CHIP_DRAG_TYPE, chip.dataset.chip ?? '')
    chip.classList.add('is-dragging')
  })

  /**
   * 拖动中就把元素插到新位置，而不是只画一条插入线：chip 很短，插到哪儿、结果是
   * 「A B C」还是「B A C」要当场看得见；等松手才跳一下，反而让人怀疑没生效。
   */
  list.addEventListener('dragover', (event) => {
    const over = (event.target as HTMLElement).closest<HTMLElement>('[data-chip]')
    if (!dragging || !over || over === dragging) return
    event.preventDefault()
    const rect = over.getBoundingClientRect()
    const after = event.clientX > rect.left + rect.width / 2
    over.parentElement?.insertBefore(dragging, after ? over.nextSibling : over)
  })

  list.addEventListener('drop', (event) => {
    if (dragging) event.preventDefault()
  })

  // dragend 一定会在拖动结束时触发（哪怕落在栏外），所以落盘放在这里最稳。
  list.addEventListener('dragend', () => {
    dragging?.classList.remove('is-dragging')
    dragging = undefined
    void persistOrder()
  })

  return {element}
}
