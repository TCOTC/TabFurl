import {listArchiveRootCandidates} from '../shared/bookmarks'
import {loadSettings, updateSettings} from '../shared/settings'
import type {FolderOption} from '../shared/types'
import {errorText, q, setStatus, type AppEvents} from './dom'

/**
 * 刷新图标。
 *
 * 用 SVG 而不是 `⟳` 字形：那个字符在不同字体里大小、粗细、基线都不一致，
 * 想调只能动字号、连带着撑高整行（与折叠三角同一个理由）。
 */
const RELOAD_ICON = `
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M15.3 2.7v4h-4" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M13.7 10a6 6 0 1 1-1.4-6.2l3 2.9" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`

const TEMPLATE = `
  <label class="root-pick__field">
    <span class="root-pick__label">存档位置</span>
    <select class="input input--sm" id="root-select"></select>
  </label>
  <button type="button" class="btn btn--ghost btn--sm" id="root-reload"
          title="重新读取书签栏" aria-label="重新读取书签栏">${RELOAD_ICON}</button>
  <p class="status" id="root-status" hidden></p>
`

export interface ArchiveRootPicker {
  readonly element: HTMLElement
  refresh(): Promise<void>
}

/**
 * 存档位置选择器，挂在顶部标签栏的右边。
 *
 * **为什么不放在面板里**：保存与存档两块都要用它，塞进任意一块都会让另一块看起来「没配置」。
 * 它不依赖任何面板，所以由 `App` 直接挂在标签栏旁边。
 *
 * **为什么没有「当前存档根：…」这类状态行**：`<select>` 选中的那一项本身就写着完整路径。
 * 只有读不到书签栏、或写不进存储时才出现一行红字——正常状态下这块 UI 只有两个控件。
 *
 * 候选只来自书签栏（`listArchiveRootCandidates()`）：扩展不建文件夹，也不往「其他书签」里写东西。
 */
export function createArchiveRootPicker(events: AppEvents): ArchiveRootPicker {
  const element = document.createElement('div')
  element.className = 'root-pick'
  element.innerHTML = TEMPLATE

  const select = q<HTMLSelectElement>(element, '#root-select')
  const reloadButton = q<HTMLButtonElement>(element, '#root-reload')
  const status = q<HTMLParagraphElement>(element, '#root-status')

  let barTitle = ''

  /** 选中项写完整路径：下拉框合上时只看得到一项，同级重名的文件夹分不出来。 */
  function optionLabel(folder: FolderOption, index: number): string {
    if (index === 0) return `${folder.title}（存档直接放在书签栏里）`
    return [barTitle, ...folder.path, folder.title].join(' / ')
  }

  /**
   * 重建选项。
   *
   * `archiveRootId` 不在候选里时（文件夹被删掉、或被挪进「其他书签」）下拉框会退回占位项，
   * 看起来就是「还没选」——需要用户做的也正是重新选一次，所以不额外提示。
   */
  async function refresh(): Promise<void> {
    setStatus(status, '', 'ok')
    try {
      const {barTitle: title, folders} = await listArchiveRootCandidates()
      barTitle = title

      select.disabled = false
      select.replaceChildren(new Option('选择书签栏里的文件夹…', ''))
      for (const [index, folder] of folders.entries()) {
        select.append(new Option(optionLabel(folder, index), folder.id))
      }
      select.value = (await loadSettings()).archiveRootId
    } catch (error) {
      // 认不出书签栏时没有任何可选项，把原因写出来，而不是留一个空下拉框让人猜。
      select.disabled = true
      select.replaceChildren(new Option('无法读取书签栏', ''))
      setStatus(status, errorText(error), 'error')
    }
  }

  // 选中即落盘：它决定另外两块能不能用，没有「保存」这一步可等。
  select.addEventListener('change', async () => {
    select.disabled = true
    try {
      await updateSettings({archiveRootId: select.value})
      setStatus(status, '', 'ok')
      // 存档根换了，保存与存档两块的数据都跟着变。
      await events.settingsChanged()
    } catch (error) {
      setStatus(status, `存档位置没能保存：${errorText(error)}`, 'error')
      select.value = (await loadSettings()).archiveRootId
    } finally {
      select.disabled = false
    }
  })

  reloadButton.addEventListener('click', async () => {
    reloadButton.disabled = true
    try {
      await refresh()
    } finally {
      reloadButton.disabled = false
    }
  })

  return {element, refresh}
}
