import {test} from 'node:test'
import assert from 'node:assert/strict'
import {flattenArchive} from './archiveRows'
import type {BookmarkNode} from '../shared/types'

const folder = (id: string, children: BookmarkNode[] = []): BookmarkNode => ({id, title: id, children})
const url = (id: string): BookmarkNode => ({id, title: id, url: `https://${id}.test/`})

test('flattenArchive：不展开时只有第一层，顺序与数组一致', () => {
  const children = [folder('a'), folder('b'), url('c')]
  const rows = flattenArchive(children, 'root', new Set())
  assert.deepEqual(
    rows.map((row) => (row.kind === 'node' ? row.node.id : '<empty>')),
    ['a', 'b', 'c']
  )
})

test('flattenArchive：展开的文件夹子级就地插在它后面，不是排到末尾', () => {
  const children = [folder('a', [url('a1')]), url('c')]
  const rows = flattenArchive(children, 'root', new Set(['a']))
  assert.deepEqual(
    rows.map((row) => (row.kind === 'node' ? row.node.id : '<empty>')),
    ['a', 'a1', 'c']
  )
})

test('flattenArchive：展开的空文件夹补一行 empty（否则点开像「点了没反应」）', () => {
  const rows = flattenArchive([folder('a')], 'root', new Set(['a']))
  assert.equal(rows.length, 2)
  assert.equal(rows[1].kind, 'empty')
  assert.equal(rows[1].depth, 1)
})

test('flattenArchive：书签永远不展开（它没有子级可推）', () => {
  const rows = flattenArchive([url('c')], 'root', new Set(['c']))
  assert.equal(rows.length, 1)
})

test('flattenArchive：depth 是层级，siblingIndex 是**同一层内**的下标', () => {
  const children = [folder('a', [url('a1'), url('a2')]), url('c')]
  const rows = flattenArchive(children, 'root', new Set(['a']))
  const node = (id: string) => {
    const row = rows.find((item) => item.kind === 'node' && item.node.id === id)
    assert.ok(row && row.kind === 'node')
    return row
  }
  // 顶层两条：0 与 1；子级重新从 0 起（拖拽要的是「同一层里的第几格」）。
  assert.deepEqual([node('a').siblingIndex, node('c').siblingIndex], [0, 1])
  assert.deepEqual([node('a1').siblingIndex, node('a2').siblingIndex], [0, 1])
  assert.deepEqual([node('a').depth, node('a1').depth], [0, 1])
})

test('flattenArchive：顶层行的 parentId 是调用方给的那一层（不是空串）', () => {
  const rows = flattenArchive([url('c')], 'some-folder', new Set())
  assert.equal(rows[0].kind === 'node' ? rows[0].parentId : '', 'some-folder')
})

test('flattenArchive：展开状态里含已不在的 id 不会出错（自愈由调用方做）', () => {
  const rows = flattenArchive([url('c')], 'root', new Set(['gone']))
  assert.equal(rows.length, 1)
})
