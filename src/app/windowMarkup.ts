import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {TabSnapshot} from '../shared/types'
import type {WindowChild} from '../shared/capture'
import {FAVICON_BASE, PIN_ICON} from './icons'

/**
 * 中间按钮上的计数。
 *
 * 括号用**半角并留一个空格**：全角括号在中文字体里占满一格，与数字之间看着空得发虚。
 * 位数变化带来的宽度差由按钮自己的 `min-width` 吃掉（见 base.css 的 `--move-btn-min`），
 * 不在这里预留。
 */
export function countLabel(text: string, count: number): string {
  return `${text} (${count})`
}

/**
 * 左栏里正在等第二次确认的关闭目标。
 *
 * 分组**按 `groupId` 记，不按下标**：确认态要跨越两次点击，这中间窗口结构可能变，
 * 下标会滑到另一个分组上（拿标题反查也不行：同名分组合法存在）。
 */
export type CloseTarget = {kind: 'tab'; tabId: number} | {kind: 'group'; groupId: number}

/** 关闭目标的主键：`t<tabId>` / `g<groupId>`。用一个字符串就够了（不分两种状态）。 */
export function closeKey(target: CloseTarget): string {
  return target.kind === 'tab' ? `t${target.tabId}` : `g${target.groupId}`
}

/** `data-close` 值 → 关闭目标（`closeKey` 的逆运算）。 */
export function parseCloseKey(value: string): CloseTarget {
  const id = Number(value.slice(1))
  return value.startsWith('t') ? {kind: 'tab', tabId: id} : {kind: 'group', groupId: id}
}

/** 当前正在等确认的那个关闭目标的主键（`undefined` = 没有）。 */
export function pendingCloseKey(pending: CloseTarget | undefined): string | undefined {
  return pending ? closeKey(pending) : undefined
}

/**
 * 行尾那一对「关闭 / 确认关闭 + 取消」。`key` 就是 `closeKey(target)` 的结果。
 *
 * 关闭是**不可逆**的（标签里的内容没存下来就没了），而它在行尾离「打开」只有一个按钮的距离，
 * 误点太容易 → 一律两步确认。两档宽度并不相同，但**不刻意定宽**：代价只是这一行里
 * 「打开」往左让一格；反过来若预留那么宽，每一行平时都要白占 70 像素的标题空间。
 */
export function closeSlotMarkup(key: string, label: string, pendingKey: string | undefined): string {
  if (pendingKey !== key) {
    return `<button type="button" class="btn btn--ghost btn--sm" data-close="${key}"
                title="${label}">关闭</button>`
  }
  return `<button type="button" class="btn btn--danger btn--sm" data-confirm-close="${key}"
              title="${label}">确认关闭</button>
          <button type="button" class="btn btn--ghost btn--sm" data-cancel-close="">取消</button>`
}

/**
 * 行尾那个位置的三种样子（加载 / 加载中 / 释放）：
 * - `unloaded` → 可点的「加载」；
 * - `loading` → 「加载中」并禁用。这一段可能很久，而**页面什么时候给标题由网站自己决定**
 *   （重 SPA 在标签不可见时走不到设置标题那一步）→ 显示「加载中」比让按钮无声消失诚实；
 * - `complete` 且**非活动** → 「释放」（把内存交回去，点开时再加载）。
 *   活动标签不给：它就在屏幕上，卸载马上会被读回来（判据同 Chromium 自己的 discards 页）。
 *
 * 三档共用 `.btn--load` 定宽：两个字与三个字不定宽就会在切档时差一个字宽。
 */
export function statusSlotMarkup(tab: TabSnapshot): string {
  if (tab.status === 'unloaded') {
    return `<button type="button" class="btn btn--ghost btn--sm btn--load" data-load-tab="${tab.tabId}"
                title="在后台加载这一页（标签已卸载）">加载</button>`
  }
  if (tab.status === 'loading') {
    return `<button type="button" class="btn btn--ghost btn--sm btn--load" disabled
                title="这一页正在加载">加载中</button>`
  }
  if (tab.active) return ''
  return `<button type="button" class="btn btn--ghost btn--sm btn--load" data-release-tab="${tab.tabId}"
              title="释放这一页占用的内存（点开时才重新加载，地址不会丢）">释放</button>`
}

/**
 * 一条标签行。三个 data 属性各有用处：`data-row` 供「点整行切换勾选」找到勾选框；
 * `data-tab-index` / `data-tab-group` 供拖拽算落点。
 * 副文案是**完整网址**（与右栏一致）：同站不同页靠路径区分，只显主机名时两条看着一模一样。
 * 行尾按钮从左到右：**状态（加载/加载中/释放）· 打开 · 关闭**。
 */
export function tabRowMarkup(tab: TabSnapshot, pendingKey: string | undefined): string {
  const url = tab.url
  const groupAttr = tab.groupId === undefined ? '' : ` data-tab-group="${tab.groupId}"`
  return `
    <li class="item leaf" draggable="true" data-row data-drop-row="tab"
        data-tab-index="${tab.index}"${groupAttr} data-drag-tab="${tab.tabId}">
      <input type="checkbox" data-window-tab="${tab.tabId}" />
      ${faviconMarkup(url, FAVICON_BASE)}
      <span class="item__main">
        <span class="item__title">${escapeHtml(tab.title || url)}${tab.pinned ? PIN_ICON : ''}</span>
        <span class="item__meta item__meta--url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
      </span>
      <span class="tree__actions">${statusSlotMarkup(tab)}
        <button type="button" class="btn btn--ghost btn--sm"
                data-switch-tab="${tab.tabId}" title="切换到这个标签页">打开</button>
        ${closeSlotMarkup(closeKey({kind: 'tab', tabId: tab.tabId}), '关闭这一枚标签页（里面的内容不会存下来）', pendingKey)}
      </span>
    </li>
  `
}

/**
 * 一个标签分组行（组内标签由调用方拼在它下面的 `.kids` 里）。
 * `groupId` 取组内第一枚：整组同属一个分组，取一个就够。
 */
export function groupRowMarkup(
  child: WindowChild & {kind: 'group'},
  index: number,
  pendingKey: string | undefined
): string {
  const bucketGroupId = child.tabs[0]?.groupId
  const groupAttr = bucketGroupId === undefined ? '' : ` data-group-id="${bucketGroupId}"`
  const label = `解散这一组并关闭它的全部标签页（共 ${child.tabs.length} 枚已列出；组里的浏览器内部页面也会一起关）`
  // 关闭要按 groupId 问浏览器要这一组的全部标签（界面这份跳过了内部页面，关的时候跳过就错了）。
  // 拿不到 groupId 时不给按钮：给了也只能按名字 / 下标猜。
  const close = bucketGroupId === undefined
    ? ''
    : closeSlotMarkup(closeKey({kind: 'group', groupId: bucketGroupId}), label, pendingKey)
  return `
    <li class="group" data-row data-drop-row="group"${groupAttr}>
      <div class="item group__head" draggable="true" data-drag-group="${index}">
        <input type="checkbox" data-window-group="${index}" />
        <span class="item__title">${escapeHtml(child.name)}</span>
        <span class="item__meta">${child.tabs.length} 个标签</span>
        <span class="tree__actions">${close}</span>
      </div>
      <ul class="kids">${child.tabs.map((tab) => tabRowMarkup(tab, pendingKey)).join('')}</ul>
    </li>
  `
}

/**
 * 一行里影响「画出来什么」的字段，顺序即渲染顺序。
 *
 * 不止行里看得见的：**写进行上 `data-` 属性的也算**，它们决定下一次拖拽落在哪。
 * - `active` 不显示，但决定行尾给不给「释放」；
 * - `index` / `groupId` 写进 `data-tab-index` / `data-tab-group`，漏掉时标签被挪或归组后
 *   签名不变 → 不重绘 → 行上留着过期下标，下一次拖拽会落到错的位置。
 */
export function drawnFieldsOf(tab: TabSnapshot): (string | number)[] {
  return [
    tab.tabId,
    tab.title,
    tab.url,
    tab.pinned ? 1 : 0,
    tab.status,
    tab.active ? 1 : 0,
    tab.index,
    tab.groupId ?? -1
  ]
}

/**
 * 左栏现在的样子：结构 + 文本。
 *
 * **勾选不在签名里**（由 `syncWindowStates()` 回填，算进去会「勾一下重绘整列」）；
 * 但**行里画出来的东西一个都不能漏**（漏 `status` → 点「加载」后那行不变；漏 `pinned` → 图钉要等别的变化才出现）。
 * 拼串用 `JSON.stringify`，**不自己定分隔符**：手写分隔符要求「内容里不会出现这个字符」，而标题与网址里什么都有
 *（实测：空格拼时 `[a, b, a b]` 与 `[a b, a, b]` 撞成同一个串）。代价是字段要显式列出——而这恰好是想要的
 *（整份快照会把每点一次就变的 `lastAccessed` 也算上）。细节见 `AGENTS.md`。
 */
export function windowSignatureOf(children: readonly WindowChild[]): string {
  return JSON.stringify(
    children.map((child) =>
      child.kind === 'tab'
        ? ['t', ...drawnFieldsOf(child.tab)]
        : ['g', child.name, child.tabs.map(drawnFieldsOf)]
    )
  )
}
