import {listDefaultFolderCandidates} from '../shared/bookmarks'
import {loadSettings, updateSettings} from '../shared/settings'
import type {FolderOption} from '../shared/types'
import {errorText, q, setStatus, type AppEvents} from './dom'

/**
 * 下拉框除文字之外还要占的宽度：左右内边距与描边，加上原生下拉箭头的位。
 *
 * 它是量出来的（不是设计尺度）：把「那行字的宽度」加上它，下拉框就刚好框住选中项的整条路径。
 * 只能写死，因为这几个量由浏览器绘制、拿不到数值。
 */
const SELECT_CHROME_PX = 40

/**
 * 下拉框的宽度上限。
 *
 * 为什么必须有：路径能长到离谱（实测一条 82 字的 `书签栏 / 归档 / 2024.07 …… / Unicode 等`
 * 要 528px），真按文字宽度铺开就会把表头顶穿、连累整页多出一条横向滚动条。
 * 上限之外的部分由原生下拉框自己裁掉，完整路径写在 `title` 上。
 */
const MAX_SELECT_PX = 320

const TEMPLATE = `
  <label class="folder-pick__field">
    <span class="folder-pick__label">默认展示文件夹</span>
    <select class="input input--sm" id="folder-select"></select>
  </label>
  <!-- 量文字宽度的隐藏尺子：与下拉框同一字体，white-space: pre 才不会折叠空格。 -->
  <span class="folder-pick__ruler" id="folder-ruler" aria-hidden="true"></span>
  <p class="status" id="folder-status" hidden></p>
`

export interface DefaultFolderPicker {
  readonly element: HTMLElement
  refresh(): Promise<void>
}

/**
 * 默认展示文件夹选择器，挂在**右栏表头**（由 `App` 挂进面板留出的位置，见 `FOLDER_PICK_HOST_ID`）。
 *
 * **它是「起点」而不是「边界」**，所以叫「默认展示文件夹」而不是「存档位置 / 存档根」：
 * 它决定打开界面时右栏落在哪一层；而右栏可以在书签树里自由导航，写入跟的始终是当前展示的那一层。
 * 叫「存储位置」会让人以为只能往这一个文件夹里存——那就与右栏的双击进入自相矛盾了。
 *
 * **宽度跟着选中的那条路径走**：候选是按完整路径写的（`书签栏 / 工具 / 在线工具`），
 * 固定宽度要么把长路径截掉、要么给短路径留一大片空白。所以每次换选项都量一次那行字
 * （用那把隐藏尺子），把下拉框调到刚好框住它。
 *
 * **没有「重新读取书签栏」按钮**：候选在每次**获得焦点**时重建一次——
 * 用户点开下拉框之前，刚在浏览器收藏夹里新建的文件夹就已经进来了。
 * 局限也说清楚：它只覆盖「下拉框还没弹出」那一瞬，所以第一次点开看到的可能还是上一次的列表，
 * 再点一次就是新的（选择本身不受影响）。
 *
 * **为什么没有「当前展示：…」这类状态行**：右栏自己的面包屑就是那句话，这里再说一遍只是重复。
 * 只有读不到书签栏、或写不进存储时才出现一行红字——正常状态下这块 UI 只有一个下拉框。
 *
 * 候选只来自书签栏（`listDefaultFolderCandidates()`）：扩展不建文件夹，也不往「其他书签」里写东西。
 */
export function createDefaultFolderPicker(events: AppEvents): DefaultFolderPicker {
  const element = document.createElement('div')
  element.className = 'folder-pick'
  element.innerHTML = TEMPLATE

  const select = q<HTMLSelectElement>(element, '#folder-select')
  const ruler = q<HTMLSpanElement>(element, '#folder-ruler')
  const status = q<HTMLParagraphElement>(element, '#folder-status')

  let barTitle = ''

  /** 选中项写完整路径：下拉框合上时只看得到一项，同级重名的文件夹分不出来。 */
  function optionLabel(folder: FolderOption, index: number): string {
    if (index === 0) return `${folder.title}（直接放在书签栏里）`
    return [barTitle, ...folder.path, folder.title].join(' / ')
  }

  /**
   * 把下拉框的宽度调成刚好装下选中项那一行字（但不超过 `MAX_SELECT_PX`）。
   *
   * 顺便把完整路径写进 `title`：超过上限时下拉框会把它裁掉，而这一行里没有折行的空间。
   */
  function sizeToSelection(): void {
    const option = select.selectedOptions[0]
    if (!option) return
    const label = option.textContent ?? ''
    ruler.textContent = label
    select.style.width = `${Math.min(Math.ceil(ruler.offsetWidth + SELECT_CHROME_PX), MAX_SELECT_PX)}px`
    select.title = label
  }

  /**
   * 重建选项。
   *
   * `defaultFolderId` 不在候选里时（文件夹被删掉、或被挪进「其他书签」）下拉框会退回占位项，
   * 看起来就是「还没选」——需要用户做的也正是重新选一次，所以不额外提示。
   */
  async function refresh(): Promise<void> {
    setStatus(status, '', 'ok')
    try {
      const {barTitle: title, folders} = await listDefaultFolderCandidates()
      barTitle = title

      select.disabled = false
      select.replaceChildren(new Option('选择书签栏里的文件夹…', ''))
      for (const [index, folder] of folders.entries()) {
        select.append(new Option(optionLabel(folder, index), folder.id))
      }
      select.value = (await loadSettings()).defaultFolderId
      sizeToSelection()
    } catch (error) {
      // 认不出书签栏时没有任何可选项，把原因写出来，而不是留一个空下拉框让人猜。
      select.disabled = true
      select.replaceChildren(new Option('无法读取书签栏', ''))
      setStatus(status, errorText(error), 'error')
    }
  }

  // 选中即落盘：它决定右栏能不能显示内容，没有「保存」这一步可等。
  select.addEventListener('change', async () => {
    select.disabled = true
    try {
      await updateSettings({defaultFolderId: select.value})
      setStatus(status, '', 'ok')
      // 换了起点，右栏要重新落一次位。
      await events.settingsChanged()
    } catch (error) {
      setStatus(status, `默认展示文件夹没能保存：${errorText(error)}`, 'error')
      select.value = (await loadSettings()).defaultFolderId
    } finally {
      select.disabled = false
      sizeToSelection()
    }
  })

  // 点开下拉框之前重建候选，这样不需要一个专门的「重新读取书签栏」按钮。
  select.addEventListener('focus', () => void refresh())

  return {element, refresh}
}
