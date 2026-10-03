import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {ArchiveNodeRow} from './archiveRows'
import type {BookmarkNode} from '../shared/types'

// `icons.ts` 在模块顶层就读 `chrome.runtime.getURL`，所以桩必须早于导入。
globalThis.chrome = {
  runtime: {getURL: (path: string) => `chrome-extension://stub/${path}`}
} as unknown as typeof chrome

const {archiveRowMarkup} = await import('./archiveMarkup')

const folder = (id: string, children: BookmarkNode[] = []): BookmarkNode => ({id, title: id, children})
const bookmark = (id: string): BookmarkNode => ({id, title: id, url: `https://${id}.test/`})

function nodeRow(
  node: BookmarkNode,
  depth = 0,
  siblingIndex = 0,
  expanded = false
): ArchiveNodeRow {
  return {kind: 'node', node, parentId: depth === 0 ? 'root' : 'parent', depth, siblingIndex, expanded}
}

const ctx = (over: Partial<Parameters<typeof archiveRowMarkup>[1]> = {}) => ({
  selectable: true,
  canEdit: true,
  ...over
})

const count = (html: string, needle: string): number => html.split(needle).length - 1

test('书签行：给勾选框，并带上算拖拽落点要用的三样属性', () => {
  const html = archiveRowMarkup(nodeRow(bookmark('c'), 0, 2), ctx())
  assert.equal(count(html, 'data-archive-item="c"'), 1)
  assert.match(html, /data-parent-id="root"/)
  assert.match(html, /data-sibling-index="2"/)
  assert.match(html, /data-node-id="c"/)
  assert.match(html, /data-drag-bookmark="c"/)
})

test('书签行：网址完整显示在副文案里，并另存一份给「拖到浏览器别处」', () => {
  const html = archiveRowMarkup(nodeRow(bookmark('c')), ctx())
  assert.equal(count(html, 'https://c.test/'), 3) // title 属性 + 副文案 + data-bookmark-url
  assert.match(html, /data-bookmark-url="https:\/\/c\.test\/"/)
})

test('文件夹行：进入按钮永远有，改名 / 删除只在可编辑的层上给（根的子级不能改）', () => {
  const editable = archiveRowMarkup(nodeRow(folder('f')), ctx())
  assert.match(editable, /data-enter="f"/)
  assert.match(editable, /data-rename="f"/)
  assert.match(editable, /data-delete="f"/)

  const locked = archiveRowMarkup(nodeRow(folder('f')), ctx({canEdit: false}))
  assert.match(locked, /data-enter="f"/)
  assert.equal(count(locked, 'data-rename="f"'), 0)
  assert.equal(count(locked, 'data-delete="f"'), 0)
})

test('文件夹行：副文案是两个**直属**计数，记号不算、子文件夹不递归', () => {
  const node = folder('f', [
    bookmark('f1'),
    folder('sub', [bookmark('s1'), bookmark('s2')]),
    {id: 'm', title: '', url: 'https://separator.mayastudios.com/index.php'}
  ])
  const html = archiveRowMarkup(nodeRow(node), ctx())
  assert.match(html, /1 个书签 • 1 个文件夹/)
})

test('文件夹行：展开态写在 class 与 aria-expanded 上，按钮提示跟着换', () => {
  const open = archiveRowMarkup(nodeRow(folder('f'), 0, 0, true), ctx())
  assert.match(open, /is-expanded/)
  assert.match(open, /aria-expanded="true"/)
  assert.match(open, /收起这一层/)

  const closed = archiveRowMarkup(nodeRow(folder('f'), 0, 0, false), ctx())
  assert.equal(count(closed, 'is-expanded'), 0)
  assert.match(closed, /aria-expanded="false"/)
})

test('勾选框只给「会被打开」的行：更深层的行不给（勾了却不开是假话）', () => {
  // 书签：depth ≤ 1 给；文件夹：只有 depth 0 给。
  assert.equal(count(archiveRowMarkup(nodeRow(bookmark('a'), 0), ctx()), 'data-archive-item'), 1)
  assert.equal(count(archiveRowMarkup(nodeRow(bookmark('a'), 1), ctx()), 'data-archive-item'), 1)
  assert.equal(count(archiveRowMarkup(nodeRow(bookmark('a'), 2), ctx()), 'data-archive-item'), 0)
  assert.equal(count(archiveRowMarkup(nodeRow(folder('f'), 0), ctx()), 'data-archive-item'), 1)
  assert.equal(count(archiveRowMarkup(nodeRow(folder('f'), 1), ctx()), 'data-archive-item'), 0)
})

test('没有勾选框的行用等宽占位（不给就整列左移一格）', () => {
  const deep = archiveRowMarkup(nodeRow(bookmark('a'), 2), ctx())
  assert.equal(count(deep, 'marker__slot'), 1)
})

test('整栏都不要勾选框时，连占位也不给（不白留一列）', () => {
  const html = archiveRowMarkup(nodeRow(bookmark('a')), ctx({selectable: false}))
  assert.equal(count(html, 'data-archive-item'), 0)
  assert.equal(count(html, 'marker__slot'), 0)
})

test('分隔线：没有勾选框（它不是书签），但有占位与「转成另一种」按钮', () => {
  const sep: BookmarkNode = {id: 's', title: '', url: 'https://separator.mayastudios.com/index.php'}
  const html = archiveRowMarkup(nodeRow(sep), ctx())
  assert.equal(count(html, 'data-archive-item'), 0)
  assert.equal(count(html, 'marker__slot'), 1)
  assert.match(html, /data-swap-separator="s"/)
  assert.match(html, /转间隔/) // 竖线 → 横线的目标
})

test('间隔：转化按钮指的是另一个方向（两个按钮只差一个字，目标必须成对）', () => {
  const gap: BookmarkNode = {
    id: 'g',
    title: '',
    url: 'https://separator.mayastudios.com/index.php?t=horz'
  }
  const html = archiveRowMarkup(nodeRow(gap), ctx())
  assert.match(html, /转分隔线/)
  assert.match(html, /marker--gap/)
})

test('两步删除：pendingDeleteId 命中时给「确认删除 + 取消」，否则给「删除」', () => {
  const idle = archiveRowMarkup(nodeRow(bookmark('a')), ctx())
  assert.match(idle, /data-delete="a"/)
  assert.equal(count(idle, 'data-confirm-delete'), 0)

  const pending = archiveRowMarkup(nodeRow(bookmark('a')), ctx({pendingDeleteId: 'a'}))
  assert.match(pending, /data-confirm-delete="a"/)
  assert.match(pending, /data-cancel-delete/)
  assert.equal(count(pending, 'data-delete="a"'), 0)
})

test('改名态：换成输入框，且不再给行内按钮（避免「改名时还能点删除」）', () => {
  const renaming = archiveRowMarkup(nodeRow(folder('f')), ctx({renamingId: 'f'}))
  assert.match(renaming, /data-rename-input="f"/)
  assert.equal(count(renaming, 'data-rename="f"'), 0)
  assert.equal(count(renaming, 'data-enter="f"'), 0)
})

test('分隔线改名时输入框里是清洗过的标题（首尾横杠不显示给用户）', () => {
  const sep: BookmarkNode = {
    id: 's',
    title: '教程────────────',
    url: 'https://separator.mayastudios.com/index.php'
  }
  const html = archiveRowMarkup(nodeRow(sep), ctx({renamingId: 's'}))
  assert.match(html, /value="教程"/)
})

test('空文件夹提示行：只有深度，没有任何可拖拽 / 可勾选的东西', () => {
  const html = archiveRowMarkup({kind: 'empty', depth: 2}, ctx())
  assert.match(html, /--depth:2/)
  assert.equal(count(html, 'data-drop-row'), 0)
  assert.equal(count(html, 'data-archive-item'), 0)
})

test('pickCls 只加在行首的 class 上（多选框的高亮段靠它拼）', () => {
  const html = archiveRowMarkup(nodeRow(bookmark('a')), ctx(), ' is-picked is-picked-start')
  assert.match(html, /class="item leaf is-picked is-picked-start"/)
})
