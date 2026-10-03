import {getBookmarksBarId, getNodePath, listBookmarkBarFolders} from '../shared/bookmarks'
import {loadSettings, updateSettings} from '../shared/settings'
import {escapeHtml} from '../shared/tile'
import type {FolderOption} from '../shared/types'
import {errorText, q, setStatus, type AppEvents} from './dom'

/**
 * chip 的拖动载荷类型。
 *
 * chip 的拖动只在**这一条 chip 栏内部**有意义（排序），所以它不写 `text/uri-list`、
 * 也不写面板那个 `application/x-tabfurl`——那两个类型一出现，两栏的落点判定就会把它当成
 * 「从网页拖来的链接」或「一条标签」。用一个自己的类型，别处谁都不认，只有这里认。
 */
const CHIP_DRAG_TYPE = 'application/x-tabfurl-favorite'

const PLACEHOLDER = '＋ 添加收藏…'

const TEMPLATE = `
  <div class="favs" id="fav-list" role="list" aria-label="收藏的文件夹"></div>
  <button type="button" class="btn btn--ghost btn--sm" id="fav-add-current"
          title="把右栏当前这一层收藏起来">☆ 收藏这一层</button>
  <select class="input input--sm favs__pick" id="fav-picker" aria-label="从书签栏里挑一层收藏"></select>
  <p class="status" id="fav-status" hidden></p>
`

export interface FavoriteFolders {
  readonly element: HTMLElement
  refresh(): Promise<void>
}

/**
 * 收藏文件夹 chip 栏。
 *
 * 它取代了早期的「默认展示文件夹」下拉框。那个下拉框只有一个值，而用户真正会来回走动的
 * 其实就那么几层——要的是**一键跳过去的小清单**，不是每次都在几百个文件夹里重新找一遍。
 * 它还有个副作用：暗示「只能在这一个文件夹里写」，而右栏明明可以自由导航。
 * chip 只是书签（快捷方式），不是边界。
 *
 * 四条约定：
 * - **顺序就是数组顺序，且第一个是打开界面时的落点**，所以顺序有意义，支持拖拽排序。
 * - **加收藏有两个入口**：`☆ 收藏这一层`（拿右栏当前层）与右侧那个 `＋ 添加收藏…` 下拉框
 *   （从书签栏里挑）。两条路都走同一个 `add()`，不会各写一份去重与落盘逻辑。
 * - **一个收藏都不可用时右栏自己退回书签栏**（那是 `TransferPanel` 的事），
 *   这里只负责让「一条 chip 都没有」看起来不像坏了——栏里留一句说明。
 * - **只能收藏书签栏里的层**：扩展不往「其他书签」里写东西，收藏也不该破这个例。
 *
 * 它不 import 面板、也不读面板状态：需要「用户正站在哪」时通过 `currentFolderId` **现问一次**
 * （在点按钮的那一刻问，所以永远不过期）；要跳转就发 `AppEvents.folderChosen`，由 `App` 转给面板。
 */
export function createFavoriteFolders(
  events: AppEvents,
  currentFolderId: () => string
): FavoriteFolders {
  const element = document.createElement('div')
  element.className = 'favs-bar'
  element.innerHTML = TEMPLATE

  const list = q<HTMLDivElement>(element, '#fav-list')
  const picker = q<HTMLSelectElement>(element, '#fav-picker')
  const status = q<HTMLParagraphElement>(element, '#fav-status')

  let barTitle = ''
  /** 候选下拉框上一次的签名（内容没变就不重建，与别处同一个理由）。 */
  let pickerSignature = ''
  /**
   * chip 栏上一次的签名。
   *
   * 初值是 `undefined`（还没渲染过），**不能是空串**：一个收藏都没有的时候签名同样是空串，
   * 两者一撞，「第一次就该画出空态提示」这一步会被当成「内容没变」跳过。
   * 拖动期间会改 DOM，落盘后刷新时也靠它判断要不要重建。
   */
  let lastChips: string | undefined
  /** 上一次渲染出来的 id 顺序，用来判断拖完之后是否真的要落盘。 */
  let lastOrder: string | undefined
  let dragging: HTMLElement | undefined

  function fullPath(path: readonly string[], title: string): string {
    return [barTitle, ...path, title].join(' / ')
  }

  function optionLabel(folder: FolderOption, index: number): string {
    if (index === 0) return `${folder.title}（书签栏自身）`
    return fullPath(folder.path, folder.title)
  }

  /** 当前这一层是不是在书签栏里。 */
  async function inBar(path: readonly {id: string}[]): Promise<boolean> {
    try {
      // getNodePath 的形状是 [根, 书签栏 / 其他书签 / … , …, 自身]，所以第二项就说明它属于哪个内置目录。
      return path[1]?.id === (await getBookmarksBarId())
    } catch {
      return false
    }
  }

  /**
   * 当前收藏的 id，顺手把已经失效的剔掉。
   *
   * 书签 id 是设备本地的：同步到另一台设备、或用户手动删掉文件夹之后，设置里那份就可能指向
   * 不存在的东西。这里做一次自愈——读得出路径的留下，读不出的丢掉，并且**只在真的丢掉时**
   * 才落盘（否则每次刷新都要写一次存储）。
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

  /** 两个入口共用的加收藏：去重、落盘、通知面板都在这里。 */
  async function add(folderId: string): Promise<void> {
    const stored = (await loadSettings()).favoriteFolderIds
    if (stored.includes(folderId)) {
      setStatus(status, '已经在收藏里了。', 'error')
      return
    }
    try {
      await updateSettings({favoriteFolderIds: [...stored, folderId]})
      setStatus(status, '已加入收藏。', 'ok')
      await events.favoritesChanged()
    } catch (error) {
      setStatus(status, `收藏失败：${errorText(error)}`, 'error')
    }
  }

  async function remove(folderId: string): Promise<void> {
    const stored = (await loadSettings()).favoriteFolderIds
    try {
      await updateSettings({favoriteFolderIds: stored.filter((id) => id !== folderId)})
      setStatus(status, '已取消收藏。', 'ok')
      await events.favoritesChanged()
    } catch (error) {
      setStatus(status, `取消失败：${errorText(error)}`, 'error')
    }
  }

  /** 「☆ 收藏这一层」：条件不满足时说清原因，而不是给一个灰按钮让人猜。 */
  async function addCurrent(): Promise<void> {
    const folderId = currentFolderId()
    if (!folderId) {
      setStatus(status, '右栏还没落到任何一层。', 'error')
      return
    }
    const path = await getNodePath(folderId)
    if (path.length === 0) {
      setStatus(status, '这一层已经不在了。', 'error')
      return
    }
    if (!(await inBar(path))) {
      setStatus(status, '只能收藏书签栏里的文件夹（扩展不往其他书签里写）。', 'error')
      return
    }
    await add(folderId)
  }

  function renderChips(entries: readonly {id: string; title: string; path: string}[]): void {
    const signature = entries.map((entry) => `${entry.id}\u0000${entry.title}`).join('\u0001')
    if (signature === lastChips) return
    lastChips = signature
    lastOrder = entries.map((entry) => entry.id).join('\u0000')

    if (entries.length === 0) {
      // 提示要短：它与两个入口同行，而右栏在窄窗口下只有四百来像素，
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

  /**
   * 把 chip 栏当前顺序落盘。
   *
   * 依据是 **DOM 里现在的顺序**，而不是拖动过程中算出来的下标：拖动期间是把元素真的插进
   * 新位置（见 `dragover`），所以 DOM 就是用户看到的东西，读它不会与视觉分叉。
   *
   * 与已渲染的顺序一样就不写存储（每次拖动结束都写一次，会让设置变更事件白跑一趟）。
   */
  async function persistOrder(): Promise<void> {
    const ids = [...list.querySelectorAll<HTMLElement>('[data-chip]')].map(
      (chip) => chip.dataset.chip as string
    )
    if (ids.length === 0 || ids.join('\u0000') === lastOrder) return
    try {
      await updateSettings({favoriteFolderIds: ids})
      await events.favoritesChanged()
    } catch (error) {
      setStatus(status, `保存顺序失败：${errorText(error)}`, 'error')
    }
  }

  async function refresh(): Promise<void> {
    setStatus(status, '', 'ok')
    try {
      const ids = await liveIds()
      const entries: {id: string; title: string; path: string}[] = []
      for (const id of ids) {
        const path = await getNodePath(id)
        entries.push({
          id,
          title: path.at(-1)?.title ?? '',
          path: path.map((node) => node.title).join(' / ')
        })
      }
      renderChips(entries)

      const {barTitle: title, folders} = await listBookmarkBarFolders()
      barTitle = title
      const signature = folders
        .map((folder, index) => `${folder.id}\u0000${optionLabel(folder, index)}`)
        .join('\u0001')
      // 候选没变就不重建：重建会把下拉框已经显示好的那一行闪一下（与别处同一个理由）。
      if (signature !== pickerSignature) {
        pickerSignature = signature
        picker.replaceChildren(new Option(PLACEHOLDER, ''))
        for (const [index, folder] of folders.entries()) {
          picker.append(new Option(optionLabel(folder, index), folder.id))
        }
      }
      picker.value = ''
    } catch (error) {
      // 认不出书签栏时两个入口都没得选，把原因写出来，而不是留一堆空控件让人猜。
      picker.disabled = true
      picker.replaceChildren(new Option('无法读取书签栏', ''))
      pickerSignature = ''
      lastChips = undefined
      lastOrder = undefined
      list.innerHTML = ''
      setStatus(status, errorText(error), 'error')
    }
  }

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
      void events.folderChosen(goButton.dataset.gotoChip)
      return
    }

    if (target.closest('#fav-add-current')) void addCurrent()
  })

  // 选一个就加一个：加完拨回占位项，否则下拉框会一直显示「刚加过的那一层」，
  // 再点同一项不会触发 change（看着像没反应）。
  picker.addEventListener('change', () => {
    const id = picker.value
    picker.value = ''
    if (id) void add(id)
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

  return {element, refresh}
}
