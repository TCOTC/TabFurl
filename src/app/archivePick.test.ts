import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  isOpenableRow,
  isWithinPick,
  pickOwnerOf,
  planPickedMove,
  rangeBetween,
  splitPicked
} from './archivePick'
import {flattenArchive, type ArchiveNodeRow} from './archiveRows'
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

const nodeRow = (node: BookmarkNode, depth = 0): ArchiveNodeRow => ({
  kind: 'node',
  node,
  parentId: 'root',
  depth,
  siblingIndex: 0,
  expanded: false
})

test('isOpenableRow：只有「打开」范围内的行能点选（书签 depth ≤ 1、文件夹 depth 0 且有内容）', () => {
  const withBookmark = folder('f', [bookmark('f1')])
  assert.equal(isOpenableRow(nodeRow(bookmark('a'), 0)), true)
  assert.equal(isOpenableRow(nodeRow(bookmark('a'), 1)), true)
  assert.equal(isOpenableRow(nodeRow(bookmark('a'), 2)), false)
  assert.equal(isOpenableRow(nodeRow(withBookmark, 0)), true)
  assert.equal(isOpenableRow(nodeRow(withBookmark, 1)), false)
  assert.equal(isOpenableRow(nodeRow(folder('empty'), 0)), false)
})

test('isOpenableRow：内部页面与记号都不能点选（点了也打不开）', () => {
  const internal: BookmarkNode = {id: 'i', title: 'discards', url: 'chrome://discards/'}
  const separator: BookmarkNode = {
    id: 's',
    title: '',
    url: 'https://separator.mayastudios.com/index.php'
  }
  assert.equal(isOpenableRow(nodeRow(internal)), false)
  assert.equal(isOpenableRow(nodeRow(separator)), false)
})

test('isWithinPick：点选文件夹等于选中整棵子树，后代不必自己再进集合', () => {
  const parents = parentIndex(sampleTree())
  const picked = new Set(['a'])
  assert.equal(isWithinPick('a', picked, parents), true)
  assert.equal(isWithinPick('a1', picked, parents), true)
  assert.equal(isWithinPick('a2x', picked, parents), true)
  assert.equal(isWithinPick('b', picked, parents), false)
})

test('splitPicked：同一份名单分成「会被打开」与「不会被打开」，两半加起来就是全部', () => {
  const parents = parentIndex(sampleTree())
  const ids = ['a1', 'a2x', 'b']
  const {picked, excluded} = splitPicked(ids, new Set(['a2']), parents)
  assert.deepEqual(picked, ['a2x'])
  assert.deepEqual(excluded, ['a1', 'b'])
})

test('splitPicked：一个都没选时整份名单都排除（按钮置灰只是界面层，这里口径也不能反）', () => {
  const ids = ['a1', 'a2x', 'b']
  assert.deepEqual(splitPicked(ids, new Set(), parentIndex(sampleTree())), {
    picked: [],
    excluded: ids
  })
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

test('planPickedMove：给了落点下标时，已在目标那一层的也一起挪（不算「动不了」）', () => {
  const parents = parentIndex(sampleTree())
  const plan = planPickedMove(['a1', 'b'], 'root', {
    parentOf: (id) => parents.get(id),
    destPath: new Set(['root']),
    atPosition: true
  })
  assert.deepEqual(plan, {ordered: ['a1', 'b'], here: 0, cyclic: 0})
})

test('planPickedMove：追加到末尾时，已在目标那一层的跳过并数出来', () => {
  const parents = parentIndex(sampleTree())
  const plan = planPickedMove(['a1', 'b'], 'root', {
    parentOf: (id) => parents.get(id),
    destPath: new Set(['root']),
    atPosition: false
  })
  assert.deepEqual(plan, {ordered: ['a1'], here: 1, cyclic: 0})
})

test('planPickedMove：目标层在自己的子孙里 → 算成环（不管有没有落点下标）', () => {
  const parents = parentIndex(sampleTree())
  for (const atPosition of [true, false]) {
    const plan = planPickedMove(['a', 'b'], 'a2', {
      parentOf: (id) => parents.get(id),
      destPath: new Set(['root', 'a', 'a2']),
      atPosition
    })
    assert.deepEqual(plan, {ordered: ['b'], here: 0, cyclic: 1})
  }
})

test('planPickedMove：顺序按载荷来的（落进修的目标层就是这个顺序）', () => {
  const parents = parentIndex(sampleTree())
  const plan = planPickedMove(['b', 'a1', 'a2x'], 'root', {
    parentOf: (id) => parents.get(id),
    destPath: new Set(['root']),
    atPosition: true
  })
  assert.deepEqual(plan.ordered, ['b', 'a1', 'a2x'])
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
