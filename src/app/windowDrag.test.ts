import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {WindowChild} from '../shared/capture'
import type {TabSnapshot} from '../shared/types'
import type {DragPayload} from './dom'

// `icons.ts` 里没有模块级 chrome 调用，但 `windowMarkup` 会拉 `tile.ts`——
// 它只用 `urls.ts` 的纯函数，所以这里不需要桩。留个空桩以防将来变化。
globalThis.chrome = {runtime: {getURL: (path: string) => `chrome-extension://stub/${path}`}} as never

const {
  anchorInsertIndex,
  childrenFor,
  moveIndexFor,
  payloadFromDataset,
  payloadNodeId,
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
  assert.equal(payloadNodeId({kind: 'selection', ids: ['f']}), undefined)
  assert.equal(payloadNodeId(undefined), undefined)
})

test('childrenFor：拖整个分组就是整个分组', () => {
  const children = childrenFor({kind: 'group', index: 1}, sampleChildren())
  assert.equal(children.length, 1)
  assert.equal(children[0].kind === 'group' ? children[0].name : '', '工作')
})

test('childrenFor：从分组里拖**单枚**标签出来，只写这一枚（不把整组建一遍）', () => {
  const children = childrenFor({kind: 'tab', tabId: 3}, sampleChildren())
  assert.equal(children.length, 1)
  assert.equal(children[0].kind, 'tab')
  assert.equal(children[0].kind === 'tab' ? children[0].tab.tabId : 0, 3)
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

test('moveIndexFor：分组拖到自己组内某一枚的位置上不算「拖到自己」（组里有多枚）', () => {
  const dragged = [tab(2, 1), tab(3, 2)]
  // 落在组内第一枚上：不是「原地不动」，而是一次正当的排序。
  assert.equal(typeof moveIndexFor({kind: 'tab', anchorIndex: 1, after: true}, dragged, 4), 'number')
})

test('moveIndexFor：落在末尾 = 总数 - 自身枚数', () => {
  assert.equal(moveIndexFor({kind: 'end'}, [tab(2, 1)], 4), 3)
  assert.equal(moveIndexFor({kind: 'end'}, [tab(2, 1), tab(3, 2)], 4), 2)
})

test('moveIndexFor：没有可拖的标签时返回 undefined', () => {
  assert.equal(moveIndexFor({kind: 'end'}, [], 4), undefined)
})
