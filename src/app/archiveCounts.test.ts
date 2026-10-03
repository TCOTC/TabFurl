import {test} from 'node:test'
import assert from 'node:assert/strict'
import {archiveBookmarkIds, countValue, folderBookmarkIds, keptCount} from './archiveCounts'
import {GAP_URL, SEPARATOR_URL} from '../shared/urls'
import type {BookmarkNode} from '../shared/types'

const bookmark = (id: string): BookmarkNode => ({id, title: id, url: `https://${id}.test/`})
const folder = (id: string, children: BookmarkNode[] = []): BookmarkNode => ({id, title: id, children})
/** 浏览器内部页面：它是真书签（渲染得出来），但扩展打不开它。 */
const internal = (id: string, url = 'chrome://discards/'): BookmarkNode => ({id, title: id, url})
const marker = (id: string, kind: 'sep' | 'gap' = 'sep'): BookmarkNode => ({
  id,
  title: '',
  url: kind === 'sep' ? SEPARATOR_URL : GAP_URL
})

test('archiveBookmarkIds：散装书签 + 每个直属子文件夹里的书签', () => {
  const children = [bookmark('a'), folder('f', [bookmark('f1'), bookmark('f2')]), bookmark('b')]
  assert.deepEqual(archiveBookmarkIds(children), ['a', 'f1', 'f2', 'b'])
})

test('archiveBookmarkIds：两种记号都不进名单（「打开（N）」不能多算）', () => {
  const children = [marker('s'), bookmark('a'), marker('g', 'gap')]
  assert.deepEqual(archiveBookmarkIds(children), ['a'])
})

test('archiveBookmarkIds：不递归到孙辈（restoreFolder 只处理一层）', () => {
  const deep = folder('g', [bookmark('g1')])
  const children = [folder('f', [bookmark('f1'), deep])]
  assert.deepEqual(archiveBookmarkIds(children), ['f1'])
})

test('folderBookmarkIds：只算直属真书签，记号与子文件夹都不算', () => {
  const target = folder('f', [bookmark('f1'), marker('s'), folder('sub', [bookmark('s1')])])
  assert.deepEqual(folderBookmarkIds(target), ['f1'])
})

test('keptCount：减去排除集里的那些', () => {
  assert.equal(keptCount(['a', 'b', 'c'], new Set(['b'])), 2)
  assert.equal(keptCount(['a'], new Set()), 1)
})

test('countValue：子文件夹 + 真书签；记号两边都不占', () => {
  const children = [folder('f'), bookmark('a'), marker('s'), folder('g')]
  // 2 个文件夹 + 1 枚真书签；那枚记号两边都不算。（写成 4 就是「把记号也算进去了」。）
  assert.equal(countValue(children), 3)
})

test('countValue：空层是 0（胸章不能显示成 1）', () => {
  assert.equal(countValue([]), 0)
})

test('countValue：只含记号的一层是 0（线不是「能干活的东西」）', () => {
  assert.equal(countValue([marker('s'), marker('g', 'gap')]), 0)
})

test('内部页面不进「会被打开」的名单（按钮上写 5 枚、实际只开 4 枚是最糟的）', () => {
  const children = [bookmark('a'), internal('x'), folder('f', [bookmark('f1'), internal('y')])]
  assert.deepEqual(archiveBookmarkIds(children), ['a', 'f1'])
})

test('一个文件夹里只有内部页面时，它没有「会被打开」的书签（勾选框不能给）', () => {
  assert.deepEqual(folderBookmarkIds(folder('f', [internal('y')])), [])
  assert.deepEqual(folderBookmarkIds(folder('f', [])), [])
})

test('countValue：内部页面两边都不算（与「打开（N）」同一口径）', () => {
  // 1 个文件夹 + 1 枚可打开的书签；内部页面与记号都不占。
  assert.equal(countValue([folder('f'), bookmark('a'), internal('x'), marker('s')]), 2)
})

test('data: 网址同样算内部（它也是扩展打不开的）', () => {
  const children = [internal('d', 'data:text/html,hi'), bookmark('a')]
  assert.deepEqual(archiveBookmarkIds(children), ['a'])
})
