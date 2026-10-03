/**
 * 界面里用到的内联 SVG 图标。
 *
 * **不写字形**（`☆`、`＋`、`|`）：同一字符在各字体里的字身、粗细与基线都不同，摆在一排就歪；
 * SVG 的尺寸与描边由我们定，还能用 `currentColor` 跟文字色走。
 * **集中一份**：同一个图形只允许一个实现（与命名规则、行条目排版同一条规矩）。
 * 除 `PIN_ICON` 外都是装饰，语义由外层按钮的 `aria-label` / `title` 给。
 */

/**
 * Chrome 本地 favicon 缓存端点（`_favicon/`）：读缓存、不联网。
 * 放这里而不是各栏各写一份：拼错**不报错**，只是静默地让每一行退化成默认地球。
 */
export const FAVICON_BASE = chrome.runtime.getURL('_favicon/')

/** 「已固定」标记。与文件夹图标同理，不用 emoji：它在灰字里是个突如其来的彩色块。 */
export const PIN_ICON = `
  <svg class="icon icon--xs item__pin" viewBox="0 0 24 24" role="img" aria-label="已固定">
    <path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3Z"
          fill="currentColor" />
  </svg>
`

/**
 * 文件夹图标。右栏里它不只是装饰：两种行都带勾选框，而勾选框左边的位置以前是空的，
 * 文件夹行看起来就与书签行一样。放上它之后，「这一行可以进去」与「这一行是个页面」左侧一眼可分。
 */
export const FOLDER_ICON = `
  <svg class="folder-tile__icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h2.6a1 1 0 0 1 .8.4l.9 1.2h5.2A1.5 1.5 0 0 1 14.25 6.1v5.4A1.5 1.5 0 0 1 12.75 13H3.25A1.5 1.5 0 0 1 1.75 11.5Z"
          fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
  </svg>
`

/**
 * 折叠三角：文件夹行左侧那枚方块的**第二副面孔**。与 `FOLDER_ICON` 占**同一个槽位**，两枚同时放在里面、
 * 一次只显一枚：平时文件夹，悬停换成它，展开后**常显**并转 90°。
 * 做成两枚而不是把文件夹转一下（转一个文件夹只会得到一支歪的文件夹）。展开后常显是关键：
 * 不常显的话「怎么收起来」得先悬停才知道，而鼠标一离开这行就再没有线索说「这里展开过」。
 */
export const CHEVRON_ICON = `
  <svg class="folder-tile__chevron" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`

/**
 * 加号。尺寸交给 `className`（两处语境不同：中栏方向按钮要 15px 的 `move__icon`，chip 栏用默认 14px），
 * 但**描边不跟着变**——同一个加号在两处粗细不同，看着就像两个人画的。
 */
export function plusIcon(className = 'icon'): string {
  return `
  <svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round" />
  </svg>
`
}

/**
 * 「打开书签管理器」：一本翻开的书。它取代了原来那句四字文案——那个按钮与刷新按钮并排，
 * 一个六个字、一个只有图标，看着像两套东西。
 */
export const OPEN_MANAGER_ICON = `
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3.4C6.9 2.6 5.4 2.3 3.6 2.3c-.7 0-1.2.5-1.2 1.1v7.3c0 .6.5 1.1 1.2 1.1 1.7 0 3 .3 4.4 1.1"
          fill="none" stroke="currentColor" stroke-width="1.3"
          stroke-linecap="round" stroke-linejoin="round" />
    <path d="M8 3.4c1.1-.8 2.6-1.1 4.4-1.1.7 0 1.2.5 1.2 1.1v7.3c0 .6-.5 1.1-1.2 1.1-1.7 0-3 .3-4.4 1.1"
          fill="none" stroke="currentColor" stroke-width="1.3"
          stroke-linecap="round" stroke-linejoin="round" />
    <path d="M8 3.4v9.5" fill="none" stroke="currentColor"
          stroke-width="1.3" stroke-linecap="round" />
  </svg>
`

/** 实心五角星：收藏。实心而不是描边——「收藏」表达的是「它已经在这儿了」，要一眼看到。 */
export const STAR_ICON = `
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6Z"
          fill="currentColor" />
  </svg>
`

/**
 * 刷新：近乎整圈的弧 + 一个箭头。弧从正上方起、逆时针绕过左下到正右方（`large-arc=1, sweep=0`），
 * 留下右上角那段缺口，箭头画在弧的终点上指向上方——正是「转了一圈回来」的样子。
 */
export const REFRESH_ICON = `
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.5A5.5 5.5 0 1 0 13.5 8" fill="none" stroke="currentColor"
          stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.5 5.1 12.1 8.4h2.8Z" fill="currentColor" />
  </svg>
`

/**
 * 分隔线的图标：一枚竖线。
 * **描边要按渲染尺寸折算**：viewBox 16 而画在 26px 槽位里 → 屏幕粗细 = `stroke-width × 26 / 16`。
 * 现在 0.9 → 约 1.5px，与 `--border-width` 那条 1px 横线同一量级，才像「一条线」而不是一块色块。
 */
export const VERT_LINE_ICON = `
  <svg class="marker__vert" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.5v11" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" />
  </svg>
`
