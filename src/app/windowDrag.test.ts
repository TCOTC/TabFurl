import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {WindowChild} from '../shared/capture'
import type {TabSnapshot} from '../shared/types'

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

// `icons.ts` 里没有模块级 chrome 调用，但 `windowMarkup` 会拉 `tile.ts`——
// 它只用 `urls.ts` 的纯函数，所以这里不需要桩。留个空桩以防将来变化。
globalThis.chrome = {runtime: {getURL: (path: string) => `chrome-extension://stub/${path}`}} as never

const {
  anchorInsertIndex,
  childrenFor,
  moveIndexFor,
  payloadFromDataset,
  payloadNodeId,
  pickWindowChildren,
  windowTabsFor
} = await import('./windowDrag')

function tab(tabId: number, index: number, groupId?: number): TabSnapshot {
  return {
    tabId,
    title: `t${tabId}`,
    url: `https://${tabId}.test/`,
    pinned: false,
    groupId,
    index,
    status: 'complete',
    active: false
  }
}

/** [散装 t1, 分组(t2, t3), 散装 t4] */
function sampleChildren(): WindowChild[] {
  return [
    {kind: 'tab', tab: tab(1, 0)},
    {kind: 'group', name: '工作', tabs: [tab(2, 1, 100), tab(3, 2, 100)]},
    {kind: 'tab', tab: tab(4, 3)}
  ]
}

const dataset = (data: Record<string, string>): DOMStringMap => data as unknown as DOMStringMap

test('payloadFromDataset：五类载荷各自从对应属性解析', () => {
  assert.deepEqual(payloadFromDataset(dataset({dragTab: '7'})), {kind: 'tab', tabId: 7})
  assert.deepEqual(payloadFromDataset(dataset({dragGroup: '2'})), {kind: 'group', index: 2})
  assert.deepEqual(payloadFromDataset(dataset({dragBookmark: 'b'})), {kind: 'bookmark', id: 'b'})
  assert.deepEqual(payloadFromDataset(dataset({dragFolder: 'f'})), {kind: 'folder', id: 'f'})
  assert.deepEqual(payloadFromDataset(dataset({dragSeparator: 's'})), {kind: 'separator', id: 's'})
})

test('payloadFromDataset：什么属性都没有时返回 undefined（那是「从网页拖来的」）', () => {
  assert.equal(payloadFromDataset(dataset({})), undefined)
})

test('payloadNodeId：只有收藏夹那三类有节点 id', () => {
  assert.equal(payloadNodeId({kind: 'bookmark', id: 'b'}), 'b')
  assert.equal(payloadNodeId({kind: 'folder', id: 'f'}), 'f')
  assert.equal(payloadNodeId({kind: 'separator', id: 's'}), 's')
  assert.equal(payloadNodeId({kind: 'tab', tabId: 1}), undefined)
  assert.equal(payloadNodeId({kind: 'tabs', tabIds: [1, 2]}), undefined)
  assert.equal(payloadNodeId({kind: 'selection', ids: ['f']}), undefined)
  assert.equal(payloadNodeId(undefined), undefined)
})

test('childrenFor：拖整个分组就是整个分组', () => {
  const children = childrenFor({kind: 'group', index: 1}, sampleChildren())
  assert.equal(children.length, 1)
  const first = at(children, 0)
  assert.equal(first.kind === 'group' ? first.name : '', '工作')
})

test('childrenFor：从分组里拖**单枚**标签出来，只写这一枚（不把整组建一遍）', () => {
  const children = childrenFor({kind: 'tab', tabId: 3}, sampleChildren())
  assert.equal(children.length, 1)
  const first = at(children, 0)
  assert.equal(first.kind, 'tab')
  assert.equal(first.kind === 'tab' ? first.tab.tabId : 0, 3)
})

test('childrenFor：多选里**整组被选中**的分组写成文件夹（分组名不能丢）', () => {
  const children = childrenFor(
    {kind: 'tabs', tabIds: [2, 3], groupKeys: ['g100']},
    sampleChildren()
  )
  assert.equal(children.length, 1)
  const first = at(children, 0)
  assert.equal(first.kind, 'group')
  assert.equal(first.kind === 'group' ? first.name : '', '工作')
})

test('childrenFor：组内标签**逐枚全选**不等于选中分组 → 写成散装书签', () => {
  const children = childrenFor({kind: 'tabs', tabIds: [2, 3]}, sampleChildren())
  assert.deepEqual(
    children.map((child) => (child.kind === 'tab' ? `t${child.tab.tabId}` : `g:${child.name}`)),
    ['t2', 't3']
  )
})

test('childrenFor：多选只碰到分组里的一部分时，那几枚当散装书签写（不把整组搬过去）', () => {
  const children = childrenFor({kind: 'tabs', tabIds: [3]}, sampleChildren())
  assert.equal(children.length, 1)
  const first = at(children, 0)
  assert.equal(first.kind, 'tab')
  assert.equal(first.kind === 'tab' ? first.tab.tabId : 0, 3)
})

test('childrenFor：多选跨组时按**窗口顺序**输出，整组仍然是整组', () => {
  // 选中 t1（散装）、整组 (t2,t3)、t4：顺序即列表顺序。
  const children = childrenFor(
    {kind: 'tabs', tabIds: [1, 2, 3, 4], groupKeys: ['g100']},
    sampleChildren()
  )
  assert.deepEqual(
    children.map((child) => (child.kind === 'tab' ? `t${child.tab.tabId}` : `g:${child.name}`)),
    ['t1', 'g:工作', 't4']
  )
})

test('pickWindowChildren：整组选中 → 整组一个文件夹；组内全选但组未选中 → 逐枚散装', () => {
  const unit = sampleChildren()
  const whole = pickWindowChildren(unit, new Set(), new Set(['g100']))
  assert.deepEqual(whole.map((child) => child.kind), ['group'])

  const loose = pickWindowChildren(unit, new Set([2, 3]), new Set())
  assert.deepEqual(loose.map((child) => child.kind), ['tab', 'tab'])
})

test('pickWindowChildren：只保留选中的散装标签与选中组，顺序即窗口顺序', () => {
  const picked = pickWindowChildren(sampleChildren(), new Set([1, 4]), new Set())
  assert.deepEqual(
    picked.map((child) => (child.kind === 'tab' ? `t${child.tab.tabId}` : `g:${child.name}`)),
    ['t1', 't4']
  )
})

test('childrenFor：找不到那一条时返回空（调用方据此不改任何东西）', () => {
  assert.deepEqual(childrenFor({kind: 'tab', tabId: 99}, sampleChildren()), [])
  assert.deepEqual(childrenFor({kind: 'group', index: 9}, sampleChildren()), [])
  assert.deepEqual(childrenFor({kind: 'folder', id: 'f'}, sampleChildren()), [])
})

test('windowTabsFor：分组给出组内**全部**标签（算插入位置要整组）', () => {
  const tabs = windowTabsFor({kind: 'group', index: 1}, sampleChildren())
  assert.deepEqual(tabs.map((item) => item.tabId), [2, 3])
})

test('windowTabsFor：多选给出那一批（组内外都算），顺序按窗口', () => {
  assert.deepEqual(windowTabsFor({kind: 'tabs', tabIds: [3, 1, 4]}, sampleChildren()).map((t) => t.tabId), [1, 3, 4])
})

test('windowTabsFor：整组被选中的分组连组内没被逐枚点到的标签一起搬', () => {
  const tabs = windowTabsFor(
    {kind: 'tabs', tabIds: [1], groupKeys: ['g100']},
    sampleChildren()
  )
  assert.deepEqual(tabs.map((t) => t.tabId), [1, 2, 3])
})

test('windowTabsFor：单枚标签在组内也能找出来', () => {
  assert.deepEqual(windowTabsFor({kind: 'tab', tabId: 2}, sampleChildren()).map((t) => t.tabId), [2])
  assert.deepEqual(windowTabsFor({kind: 'tab', tabId: 1}, sampleChildren()).map((t) => t.tabId), [1])
})

test('anchorInsertIndex：插到某枚**之前**就是它的下标（前移的那些要减掉）', () => {
  // 拖 [0] 到下标 3 之前：0 在 3 之前 → 锚点前移一格 → 3-1 = 2。
  assert.equal(anchorInsertIndex(3, false, [0]), 2)
  // 拖 [5] 到下标 3 之前：5 不在锚点前 → 3。
  assert.equal(anchorInsertIndex(3, false, [5]), 3)
})

test('anchorInsertIndex：插到某枚**之后**再加一', () => {
  assert.equal(anchorInsertIndex(3, true, [0]), 3)
  assert.equal(anchorInsertIndex(3, true, [5]), 4)
})

test('anchorInsertIndex：往回拖时把前面那几枚都减掉（不是只减一枚）', () => {
  // 拖 [0,1] 到下标 4 之前：两枚都在前面 → 4-2 = 2。
  assert.equal(anchorInsertIndex(4, false, [0, 1]), 2)
})

test('moveIndexFor：拖到自己那一行 = 原地不动（返回 undefined，不做任何事）', () => {
  const dragged = [tab(2, 1)]
  assert.equal(moveIndexFor({kind: 'tab', anchorIndex: 1, after: true}, dragged, 4), undefined)
  assert.equal(moveIndexFor({kind: 'tab', anchorIndex: 1, after: false}, dragged, 4), undefined)
})

test('moveIndexFor：锚点就是被拖的那几枚之一 → 原地不动（单枚与分组同一条规则）', () => {
  // 分组头的落点是「组内最后一枚的下缘」——锚点就在被拖的里面，公式不再适用，直接不做。
  const group = [tab(2, 3), tab(3, 4)]
  assert.equal(moveIndexFor({kind: 'tab', anchorIndex: 4, after: true}, group, 4), undefined)
  assert.equal(moveIndexFor({kind: 'tab', anchorIndex: 3, after: false}, group, 4), undefined)
  // 落点在组外才是正当的排序。
  assert.equal(typeof moveIndexFor({kind: 'tab', anchorIndex: 1, after: true}, group, 4), 'number')
})

test('moveIndexFor：落在末尾 = **最后一格**（多枚时不是「总数 - 自身枚数」）', () => {
  // `tabs.move` 多枚是「逐个搬、每搬一枚 index + 1」，传 `总数 - 枚数` 会差几格。
  assert.equal(moveIndexFor({kind: 'end'}, [tab(2, 1)], 4), 3)
  assert.equal(moveIndexFor({kind: 'end'}, [tab(2, 1), tab(3, 2)], 4), 3)
})

test('moveIndexFor：没有可拖的标签时返回 undefined', () => {
  assert.equal(moveIndexFor({kind: 'end'}, [], 4), undefined)
})
