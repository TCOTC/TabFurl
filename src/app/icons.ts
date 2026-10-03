/**
 * 界面里用到的内联 SVG 图标。
 *
 * 为什么不用字形（`☆`、`＋`、`|`）：同一个字符在各字体里的字身、粗细与基线都不同，
 * 与旁边的图标摆在一排就会歪；而 SVG 的尺寸与描边由我们自己定，还能用 `currentColor`
 * 跟着文字颜色走。
 *
 * 集中在一个模块里，理由与命名规则、行条目排版一样：同一个东西只允许有一个实现。
 * 两个界面模块都要用加号（中栏那个「新窗口」与 chip 栏的「添加收藏」），
 * 各写一份就会出现「两个加号粗细不一样」这种事。
 *
 * 除 `PIN_ICON` 外都是装饰：语义由外层按钮的 `aria-label` / `title` 给，
 * 读屏不该把「一个加号」念出来。
 */

/** 「已固定」标记。与文件夹图标同理，不用 emoji：它在灰字里是个突如其来的彩色块。 */
export const PIN_ICON = `
  <svg class="icon icon--xs item__pin" viewBox="0 0 24 24" role="img" aria-label="已固定">
    <path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3Z"
          fill="currentColor" />
  </svg>
`

/**
 * 文件夹图标。
 *
 * 右栏里它不只是装饰：两种行都带勾选框，而勾选框左边的位置以前是空的，文件夹行看起来就与书签行一样。
 * 放上它之后，「这一行可以进去」与「这一行是个页面」在左侧一眼可分。
 */
export const FOLDER_ICON = `
  <svg class="folder-tile__icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h2.6a1 1 0 0 1 .8.4l.9 1.2h5.2A1.5 1.5 0 0 1 14.25 6.1v5.4A1.5 1.5 0 0 1 12.75 13H3.25A1.5 1.5 0 0 1 1.75 11.5Z"
          fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
  </svg>
`

/**
 * 加号：新建、添加这类「多加一个」的动作。
 *
 * 尺寸交给 `className`，因为两处的语境不同：中栏那排方向按钮要 15px 的 `move__icon`
 * （与旁边的 `→` / `←` 同高），chip 栏的图标按钮用默认的 14px `icon`。
 * 描边不跟着变——同一个加号在两处粗细不同，看起来就像两个人画的。
 */
export function plusIcon(className = 'icon'): string {
  return `
  <svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round" />
  </svg>
`
}

/** 实心五角星：收藏。实心而不是描边——「收藏」表达的是「它已经在这儿了」，要一眼看到。 */
export const STAR_ICON = `
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6Z"
          fill="currentColor" />
  </svg>
`

/**
 * 刷新：一段近乎整圈的弧 + 一个箭头。
 *
 * 弧从正上方起、逆时针绕过左下到正右方（`large-arc=1, sweep=0`），留下右上角那一段缺口，
 * 箭头就画在弧的终点上指向上方——正是「转了一圈回来」的样子。
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
 *
 * **描边要按渲染尺寸折算**：viewBox 是 16，而它实际画在 26px 的槽位里，
 * 所以屏幕上的粗细是 `stroke-width × 26 / 16`。1.8 看起来是 2.9px（像一根柱子），
 * 1.4 是 2.3px（还是偏粗）。现在 0.9 → 约 1.5px：与 `--border-width` 那条 1px 的横线
 * 属于同一个量级，才像「一条线」而不是一块色块。
 */
export const VERT_LINE_ICON = `
  <svg class="marker__vert" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.5v11" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" />
  </svg>
`
