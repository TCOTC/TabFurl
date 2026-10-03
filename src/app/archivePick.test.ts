import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pickOwnerOf, rangeBetween, topLevelPicked} from './archivePick'
import {flattenArchive} from './archiveRows'
import type {BookmarkNode} from '../shared/types'

/**
 * 取第 `index` 项，并断言它存在。
 *
 * `noUncheckedIndexedAccess` 下 `items[index]` 是 `T | undefined`——那是**对的**（越界真的可能），
 * 所以这里写一条明确的断言，而不是用 `!` 把它压掉。
 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  assert.ok(value !== undefined, `第 ${index} 项不存在`)
  return value
}

const folder = (id: string, children: BookmarkNode[] = []): BookmarkNode => ({id, title: id, children})
const bookmark = (id: string): BookmarkNode => ({id, title: id, url: `https://${id}.test/`})

/** 树：a > (a1, a2 > a2x)；b */
function sampleTree(): BookmarkNode[] {
  return [folder('a', [bookmark('a1'), folder('a2', [bookmark('a2x')])]), folder('b')]
}

function parentIndex(children: readonly BookmarkNode[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (nodes: readonly BookmarkNode[], parent: string): void => {
    for (const node of nodes) {
      out.set(node.id, parent)
      walk(node.children ?? [], node.id)
    }
  }
  walk(children, 'root')
  return out
}

test('topLevelPicked：被选中文件夹的后代不再单列（否则同一棵子树会被搬两次）', () => {
  assert.deepEqual(topLevelPicked(new Set(['a', 'a1', 'a2', 'a2x']), parentIndex(sampleTree())), ['a'])
})

test('topLevelPicked：彼此无关的几条都留着', () => {
  assert.deepEqual(topLevelPicked(new Set(['a1', 'b']), parentIndex(sampleTree())), ['a1', 'b'])
})

test('topLevelPicked：空集合返回空', () => {
  assert.deepEqual(topLevelPicked(new Set(), parentIndex(sampleTree())), [])
})

test('pickOwnerOf：文件夹被选中时，它的后代行归到它名下（共用一个框）', () => {
  const rows = flattenArchive(sampleTree(), 'root', new Set(['a', 'a2']))
  const top = new Set(['a'])
  const owners = rows
    .filter((row) => row.kind === 'node')
    .map((row) => (row.kind === 'node' ? pickOwnerOf(row, top, parentIndex(sampleTree())) : undefined))
  // a / a1 / a2 / a2x 全都归 'a'，b 没有归属。
  assert.deepEqual(owners, ['a', 'a', 'a', 'a', undefined])
})

test('pickOwnerOf：空选择集时谁都不归', () => {
  const rows = flattenArchive(sampleTree(), 'root', new Set())
  assert.equal(pickOwnerOf(at(rows, 0), new Set(), parentIndex(sampleTree())), undefined)
})

test('rangeBetween：按**可见顺序**取范围，展开出来的子级也在范围内', () => {
  const rows = flattenArchive(sampleTree(), 'root', new Set(['a', 'a2']))
  // 可见顺序：a, a1, a2, a2x, b
  assert.deepEqual(rangeBetween(rows, 'a', 'a2x'), ['a', 'a1', 'a2', 'a2x'])
})

test('rangeBetween：反向拖也取同一段（起点在下、终点在上）', () => {
  const rows = flattenArchive(sampleTree(), 'root', new Set(['a', 'a2']))
  assert.deepEqual(rangeBetween(rows, 'a2x', 'a'), ['a', 'a1', 'a2', 'a2x'])
})

test('rangeBetween：同一条就是它自己', () => {
  const rows = flattenArchive(sampleTree(), 'root', new Set())
  assert.deepEqual(rangeBetween(rows, 'b', 'b'), ['b'])
})

test('rangeBetween：起点找不到时退化成「只选终点那一条」', () => {
  const rows = flattenArchive(sampleTree(), 'root', new Set())
  assert.deepEqual(rangeBetween(rows, undefined, 'b'), ['b'])
  assert.deepEqual(rangeBetween(rows, 'gone', 'b'), ['b'])
})

test('rangeBetween：不越过收起的子级（看不见的不该被选上）', () => {
  const rows = flattenArchive(sampleTree(), 'root', new Set())
  // a 收起时可见顺序是 a, b：从 a 拖到 b 只该选中这两条。
  assert.deepEqual(rangeBetween(rows, 'a', 'b'), ['a', 'b'])
})
