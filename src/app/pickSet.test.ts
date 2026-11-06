import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createPickSet, type PickSetDeps} from './pickSet'

/**
 * 一块两层的列表：根下 `a`、`b`，`a` 里有 `a1`、`a2`。
 * 与收藏夹（文件夹 → 书签）和窗口栏（分组 → 标签）同一个形状。
 */
const parents = new Map([
  ['a1', 'a'],
  ['a2', 'a']
])
const order = ['a', 'a1', 'a2', 'b']

function make(over: Partial<PickSetDeps> = {}) {
  return createPickSet({
    parentOf: (id) => parents.get(id),
    rangeTo: (from, to) => {
      const start = from === undefined ? -1 : order.indexOf(from)
      const end = order.indexOf(to)
      if (start < 0 || end < 0) return [to]
      const [lo, hi] = start <= end ? [start, end] : [end, start]
      return order.slice(lo, hi + 1)
    },
    ...over
  })
}

test('选中容器 = 选中整棵子树（后代靠父链，不必各记一条）', () => {
  const picks = make()
  picks.click({id: 'a', shift: false, toggle: true})
  assert.deepEqual(picks.ids(), ['a'])
  assert.equal(picks.within('a1'), true)
  assert.equal(picks.within('a2'), true)
  assert.equal(picks.within('b'), false)
})

test('容器选中之后再单独点它的子级：什么都不做（不是加一条冗余记录）', () => {
  const picks = make()
  picks.click({id: 'a', shift: false, toggle: true})
  const handled = picks.click({id: 'a1', shift: false, toggle: true})
  assert.equal(handled, true, '算处理过：不能让事件落到别的分支')
  assert.deepEqual(picks.ids(), ['a'])
})

test('普通点在框里不清空；点在框外才清空', () => {
  const picks = make()
  picks.click({id: 'a', shift: false, toggle: true})
  picks.click({id: 'a2', shift: false, toggle: false})
  assert.deepEqual(picks.ids(), ['a'], '点在框里 → 保持')
  picks.click({id: 'b', shift: false, toggle: false})
  assert.deepEqual(picks.ids(), [], '点在框外 → 收掉整批')
})

test('Shift 是**替换范围**（连按两次不会越选越多），而且不挪起点', () => {
  const picks = make()
  picks.click({id: 'a', shift: false, toggle: false})
  picks.click({id: 'b', shift: true, toggle: false})
  assert.deepEqual(picks.ids(), ['a', 'a1', 'a2', 'b'].filter((id) => id !== 'a1' && id !== 'a2'))
  // `a` 被选中 → 子级归约掉，所以范围里只剩 a 与 b。
  picks.click({id: 'a1', shift: true, toggle: false})
  assert.deepEqual(picks.ids(), ['a'], '范围重算仍以 a 为起点，而不是越选越多')
})

test('Shift 范围里同时含容器与它的子级 → 只留容器', () => {
  const picks = make()
  picks.click({id: 'a1', shift: false, toggle: false})
  picks.click({id: 'a2', shift: true, toggle: false})
  assert.deepEqual(picks.ids(), ['a1', 'a2'])
  // 往回 Shift 到容器那一行：范围是 [a, a1, a2]，归约后只剩容器。
  picks.click({id: 'a', shift: true, toggle: false})
  assert.deepEqual(picks.ids(), ['a'])
})

test('取消容器时不会把后代补回来（取消是一次「这一块不要了」）', () => {
  const picks = make()
  picks.click({id: 'a', shift: false, toggle: true})
  picks.click({id: 'a', shift: false, toggle: true})
  assert.equal(picks.size, 0)
})

test('点空白：有选择就清空，没选择就不算处理过', () => {
  const picks = make()
  assert.equal(picks.click({shift: false, toggle: false}), false)
  picks.click({id: 'b', shift: false, toggle: true})
  assert.equal(picks.click({shift: false, toggle: false}), true)
  assert.equal(picks.size, 0)
})

test('selectable：按不动的行什么都不做，**不能**当成点空白把已选的那批清掉', () => {
  const picks = make({selectable: (id) => id !== 'a1'})
  picks.click({id: 'b', shift: false, toggle: true})
  assert.equal(picks.click({id: 'a1', shift: false, toggle: false}), false)
  assert.deepEqual(picks.ids(), ['b'])
})

test('prune：丢掉已不存在的键，并重新归约（容器还在、子级被关掉之后）', () => {
  const picks = make()
  picks.click({id: 'a', shift: false, toggle: true})
  picks.prune(new Set(['a', 'a1', 'a2', 'b']))
  assert.deepEqual(picks.ids(), ['a'])
  picks.prune(new Set(['a1', 'a2', 'b']))
  assert.deepEqual(picks.ids(), [])
})

test('rename：键换了（释放会换 tab id）时选中跟着搬', () => {
  const picks = make()
  picks.click({id: 'a1', shift: false, toggle: true})
  picks.rename('a1', 'z1')
  assert.deepEqual(picks.ids(), ['z1'])
  // 起点也要跟着搬，否则下一次 Shift 会从半路开始（这里的 z1 不在可见顺序里，
  // 范围就退化成「只选终点那一行」——正是两个已知端点都失效时的退化）。
  picks.click({id: 'b', shift: true, toggle: false})
  assert.deepEqual(picks.ids(), ['b'])
})

test('boxFlags：按给定顺序给出每一行在不在框里（绘制高亮段用）', () => {
  const picks = make()
  picks.click({id: 'a', shift: false, toggle: true})
  assert.deepEqual(picks.boxFlags(order), [true, true, true, false])
})

test('snapshot 是一份副本，外改不影响内部', () => {
  const picks = make()
  picks.click({id: 'b', shift: false, toggle: true})
  const snap = picks.snapshot() as Set<string>
  snap.clear()
  assert.equal(picks.size, 1)
})
