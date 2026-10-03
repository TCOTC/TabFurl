import {isOpenableBookmark, openableBookmarks} from '../shared/bookmarks'
import {escapeHtml, faviconMarkup} from '../shared/tile'
import type {BookmarkNode} from '../shared/types'
import {
  SEPARATOR_LABELS,
  hostnameOf,
  separatorKind,
  separatorTitle,
  toggledSeparatorKind
} from '../shared/urls'
import {CHEVRON_ICON, FAVICON_BASE, FOLDER_ICON, VERT_LINE_ICON} from './icons'
import type {ArchiveNodeRow, ArchiveRow} from './archiveRows'

/**
 * 生成行 HTML 需要的「当前状态」。
 *
 * 全部是**读一次就不会变**的布尔量/id，所以这一整块可以做成纯函数（也因此可测）——
 * 它们不碰 DOM，只把数据拼成字符串。
 */
export interface MarkupContext {
  /** 这一栏要不要显示勾选框（两栏都是收藏夹时不要，见 `ArchivePane.setSelectable`）。 */
  selectable: boolean
  /**
   * 当前这一层能不能编辑（改名 / 删除）。与 `canWrite()` 是**同一个判据**（书签树的根）：
   * 根的子级是 Chrome 的固定文件夹，两个动作都会被浏览器拒绝 → 那些行只给「进入」。
   */
  canEdit: boolean
  /** 正在行内改名的节点 id。 */
  renamingId?: string
  /** 正在等第二次确认删除的节点 id。 */
  pendingDeleteId?: string
}

/** 没有勾选框的行用它占位：`.marker__slot` 与复选框实测都是 14px，不给就会整列左移一格。 */
const NO_BOX_SLOT = '<span class="marker__slot" aria-hidden="true"></span>'

/**
 * 这一行该不该有勾选框。**判据 = 这一行到底会不会被打开**，与 `archiveBookmarkIds()` 同口径。
 * 1. 在「打开」范围内：书签 depth ≤ 1、文件夹只有当前层直属（depth 0）；
 * 2. 是能打开的网址（内部页面与 `tabs.create` 无缘）；
 * 3. `openableCount > 0`——空层、只装子文件夹、只装内部页面的文件夹，
 *    勾上会当场弹回未勾选（`triState(0, 0)` 是 `none`），看着就是「点了没反应」。
 */
function selectableAt(
  depth: number,
  isFolder: boolean,
  selectable: boolean,
  openableCount: number
): boolean {
  if (!selectable || openableCount <= 0) return false
  return isFolder ? depth === 0 : depth <= 1
}

/**
 * 行首那一格。三种情况：
 * - **给勾选框**：这一行在「打开」范围内且真勾得上东西。分隔线永远不给（传 `undefined`）。
 * - **给等宽占位**：同一清单里别的行有勾选框，不给占位就差一格（`NO_BOX_SLOT`）。
 * - **什么都不给**：整栏都不要勾选框时（再留一列空白就只是让文字白白右移 14px）。
 */
function boxSlot(
  id: string | undefined,
  depth: number,
  isFolder: boolean,
  ctx: MarkupContext,
  openableCount: number
): string {
  if (id !== undefined && selectableAt(depth, isFolder, ctx.selectable, openableCount)) {
    return `<input type="checkbox" data-archive-item="${escapeHtml(id)}" />`
  }
  return ctx.selectable ? NO_BOX_SLOT : ''
}

/** 一条行的 HTML（三类行 + 空文件夹提示，都在这里分派）。 */
export function archiveRowMarkup(row: ArchiveRow, ctx: MarkupContext, pickCls = ''): string {
  if (row.kind === 'empty') {
    return `<li class="kids__empty" style="--depth:${row.depth}">这个文件夹是空的</li>`
  }
  return row.node.url ? bookmarkRow(row, ctx, pickCls) : folderRow(row, ctx, pickCls)
}

/**
 * 一条书签行。分隔线占位书签也画成横线，同样给「修改 / 删除」。
 *
 * 两种行**都能拖**：分隔线虽然只是个记号，但用户摆它的位置本来就有意义。
 * 分隔线没有勾选框（不是书签，见 `isRealBookmark`）；**内部页面也没有**——勾上也不会开。
 * 书签树根那三个固定文件夹的子级不能拖（见 `folderRow`）。
 *
 * 网址**完整显示**（不截成主机名）：条目本来就靠网址区分同名页面，小一号字 + 一行够装下绝大多数。
 * 真过长时仍省略，那时 `title` 里还有完整的一份。
 */
function bookmarkRow(row: ArchiveNodeRow, ctx: MarkupContext, pickCls: string): string {
  const bookmark = row.node
  // 三样东西每行都要带上：所在层（拖拽算插到哪一层的第几格）、层内下标（同一件事，
  // 但不必再去 DOM 里数兄弟）、缩进（扁平之后层级只能这样表达）。
  // `data-node-id` 是给「把这一行滚进视野」按 id 定位元素用的。
  const boxAttrs = `data-parent-id="${escapeHtml(row.parentId)}" data-sibling-index="${row.siblingIndex}" style="--depth:${row.depth}"`
  const nodeAttr = `data-node-id="${escapeHtml(bookmark.id)}"`
  const kind = separatorKind(bookmark.url)
  if (kind) {
    const isRenaming = ctx.renamingId === bookmark.id
    // 两种记号**外观完全不同**，因为它们在书签栏里的用途就不同：
    //   间隔（`?t=horz`，横向）画成一条通栏横线 —— 竖排列表里要一条横线才隔得开；
    //   分隔线（无参数，纵向）画成一枚竖线图标 —— 它是给书签栏那一排横排用的。
    const label = SEPARATOR_LABELS[kind]
    const target = SEPARATOR_LABELS[toggledSeparatorKind(kind)]
    // 两条横线用**真实元素**而不是伪元素：`::after` 永远排在所有子元素之后（这是规范定的），
    // 而按钮必须在这条线**右边**——用伪元素就只能得到「线在按钮右边」那种坏排布。
    const rules = isRenaming || kind === 'sep'
      ? ''
      : '<span class="marker__rule" aria-hidden="true"></span>'
    return `
      <li class="marker marker--${kind}${pickCls}" draggable="true" data-drop-row="separator"
          ${boxAttrs} ${nodeAttr} data-drag-separator="${escapeHtml(bookmark.id)}">
        ${boxSlot(undefined, row.depth, false, ctx, 0)}
        ${
          kind === 'sep' ? VERT_LINE_ICON : rules
        }
        ${
          isRenaming
            ? `<input type="text" class="input input--rename" draggable="false"
                      data-rename-input="${escapeHtml(bookmark.id)}"
                      value="${escapeHtml(separatorTitle(bookmark.title))}"
                      placeholder="${label}标题（可留空）" aria-label="${label}标题" />`
            : `<span class="marker__title">${escapeHtml(separatorTitle(bookmark.title))}</span>`
        }
        ${
          isRenaming || kind === 'sep' ? '' : rules
        }
        ${
          isRenaming
            ? ''
            : `<span class="tree__actions">
                 <button type="button" class="btn btn--ghost btn--sm"
                         data-swap-separator="${escapeHtml(bookmark.id)}"
                         title="改成${target}">转${target}</button>
                 <button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(bookmark.id)}">修改</button>
                 ${deleteButtons(bookmark.id, ctx.pendingDeleteId)}
               </span>`
        }
      </li>
    `
  }

  const url = bookmark.url ?? ''
  const host = hostnameOf(url) ?? url
  // 内部页面给「打开」也弹不出东西（见 `openBookmarkNow`）：它没有勾选框，只占一格。
  const boxable = isOpenableBookmark(bookmark)

  return `
    <li class="item leaf${pickCls}" data-row data-drop-row="bookmark" draggable="true"
        ${boxAttrs} ${nodeAttr} data-drag-bookmark="${escapeHtml(bookmark.id)}"
        data-bookmark-url="${escapeHtml(url)}">
      ${boxSlot(boxable ? bookmark.id : undefined, row.depth, false, ctx, boxable ? 1 : 0)}
      ${faviconMarkup(url, FAVICON_BASE)}
      <span class="item__main">
        <span class="item__title">${escapeHtml(bookmark.title.trim() || host)}</span>
        <span class="item__meta item__meta--url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
      </span>
      <span class="tree__actions">
        <button type="button" class="btn btn--ghost btn--sm" data-open="${escapeHtml(bookmark.id)}">打开</button>
        <button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(bookmark.id)}">修改</button>
        ${deleteButtons(bookmark.id, ctx.pendingDeleteId)}
      </span>
    </li>
  `
}

/**
 * 一个子文件夹行。两种「往里看」的方式，两码事：
 * - **双击这一行（或点「进入」）= 进这一层**：它变成当前展示的文件夹，面包屑负责往回走。
 * - **点左侧那枚方块 = 就地展开**：子级推开在下面、不换页。
 *
 * 两个计数都保持**直属**；「N 个书签」只算**会被打开**的书签（不含记号、不含内部页面）。
 * 这样这一行上的三个数字同一口径（勾选框只勾这层、「打开（N）」也只算这层）。**展开也不改计数**。
 *
 * 根那一层（`ctx.canEdit` 为假）的子级是 Chrome 的固定文件夹：改名 / 删除会被拒，
 * 所以那两个按钮不给，**它自己也不能被拖**（`move` 同样拒 `kModifySpecialError`）。
 */
function folderRow(row: ArchiveNodeRow, ctx: MarkupContext, pickCls: string): string {
  const folder: BookmarkNode = row.node
  const children = folder.children ?? []
  const bookmarkCount = openableBookmarks(children).length
  const folderCount = children.filter((child) => !child.url).length
  const dragAttrs = ctx.canEdit
    ? ` draggable="true" data-drag-folder="${escapeHtml(folder.id)}"`
    : ''
  const isRenaming = ctx.renamingId === folder.id
  const expanded = row.expanded

  const title = isRenaming
    ? `<input type="text" class="input input--rename" draggable="false"
              data-rename-input="${escapeHtml(folder.id)}"
              value="${escapeHtml(folder.title)}" aria-label="重命名文件夹" />`
    : `<span class="item__title">${escapeHtml(folder.title)}</span>`

  // 「进入」永远有；「改名 / 删除」只在可编辑的层上给。
  const enter = `<button type="button" class="btn btn--ghost btn--sm" data-enter="${escapeHtml(folder.id)}">进入</button>`
  const edit = ctx.canEdit
    ? `<button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(folder.id)}">改名</button>
       ${deleteButtons(folder.id, ctx.pendingDeleteId)}`
    : ''
  const actions = isRenaming ? '' : `<span class="tree__actions">${enter}${edit}</span>`

  return `
    <li class="item group__head${expanded ? ' is-expanded' : ''}${pickCls}" data-row data-drop-row="folder"
        data-parent-id="${escapeHtml(row.parentId)}" data-sibling-index="${row.siblingIndex}"
        style="--depth:${row.depth}" data-node-id="${escapeHtml(folder.id)}"
        data-drop-folder="${escapeHtml(folder.id)}" data-enter-folder="${escapeHtml(folder.id)}">
      ${boxSlot(folder.id, row.depth, true, ctx, bookmarkCount)}
      <button type="button" class="folder-tile" data-toggle-folder="${escapeHtml(folder.id)}"
              aria-expanded="${expanded}"
              title="${expanded ? '收起这一层' : '就地展开这一层（不换页）'}"
              aria-label="${expanded ? '收起' : '展开'}${escapeHtml(folder.title)}">${FOLDER_ICON}${CHEVRON_ICON}</button>
      <span class="item__main item__main--row"${dragAttrs} title="双击进入这一层">
        ${title}
        <span class="item__meta">${bookmarkCount} 个书签 • ${folderCount} 个文件夹</span>
      </span>
      ${actions}
    </li>
  `
}

/** 「删除 / 确认删除 + 取消」那一对（三类行共用，所以只写一次）。 */
function deleteButtons(id: string, pendingDeleteId: string | undefined): string {
  if (pendingDeleteId === id) {
    return `<button type="button" class="btn btn--danger btn--sm" data-confirm-delete="${escapeHtml(id)}">确认删除</button>
            <button type="button" class="btn btn--ghost btn--sm" data-cancel-delete="">取消</button>`
  }
  return `<button type="button" class="btn btn--ghost btn--sm" data-delete="${escapeHtml(id)}">删除</button>`
}
