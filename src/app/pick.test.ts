import {test} from 'node:test'
import assert from 'node:assert/strict'
import {planPickClick, type PickClickInput} from './pick'

function at(over: Partial<PickClickInput> = {}): PickClickInput {
  return {
    onBlank: false,
    shift: false,
    toggle: false,
    ownSelected: false,
    withinPick: false,
    hasPick: false,
    ...over
  }
}

test('点空白且有选择 → 清空；没选择 → 不算处理过', () => {
  assert.deepEqual(planPickClick(at({onBlank: true, hasPick: true})), {
    action: 'clear',
    moveAnchor: false
  })
  assert.equal(planPickClick(at({onBlank: true})).action, 'ignore')
})

test('点「这一档不让点」的行 → 什么都不做，且**不能**清掉已选的那批', () => {
  // 收藏夹栏的「打开」档下，更深层的书签 / 空文件夹 / 记号就落在这条路上。
  // 把它当成点空白是这个函数最容易写错的退路（已选的会被静默收掉）。
  assert.equal(
    planPickClick(at({selectable: false, hasPick: true})).action,
    'ignore'
  )
  // `selectable: undefined` 是「这一栏没有范围概念」，不触发这条守卫。
  assert.notEqual(planPickClick(at({selectable: undefined})).action, 'ignore')
})

test('Shift → 替换范围，且**不挪起点**（连按几次要能反复调范围）', () => {
  const intent = planPickClick(at({shift: true, ownSelected: true, withinPick: true, hasPick: true}))
  assert.equal(intent.action, 'extend')
  assert.equal(intent.moveAnchor, false)
})

test('Ctrl / Cmd 点在未被覆盖的一条上 → 切换', () => {
  assert.deepEqual(planPickClick(at({toggle: true})), {action: 'toggle', moveAnchor: true})
})

test('Ctrl 点已被容器覆盖的子级 → 只挪起点，不动选择（否则记一条点不动的冗余项）', () => {
  assert.deepEqual(planPickClick(at({toggle: true, withinPick: true})), {
    action: 'keep',
    moveAnchor: true
  })
  // 容器自己被选中时照常可以取消（`ownSelected` 优先于 `withinPick`）。
  assert.equal(planPickClick(at({toggle: true, ownSelected: true, withinPick: true})).action, 'toggle')
})

test('普通点击在框里 → 不动选择（按住它把整批拖走是常见动作）', () => {
  assert.deepEqual(planPickClick(at({withinPick: true, hasPick: true})), {
    action: 'keep',
    moveAnchor: true
  })
  // 因祖先而在框里也一样。
  assert.deepEqual(
    planPickClick(at({withinPick: true, ownSelected: false, hasPick: true})),
    {action: 'keep', moveAnchor: true}
  )
})

test('普通点击在框外 → 收掉已选的那批，并把起点挪过来', () => {
  assert.deepEqual(planPickClick(at({hasPick: true})), {action: 'clear', moveAnchor: true})
})

test('普通点击在框外且本来没有选择 → 只挪起点（不算一次清空）', () => {
  assert.deepEqual(planPickClick(at()), {action: 'keep', moveAnchor: true})
})

test('修饰键优先级：Shift 高于 Ctrl，Ctrl 高于普通点击', () => {
  // 三个键一起按（真实键盘下会这样）时行为必须确定，不能让 Ctrl 悄悄盖过 Shift。
  assert.equal(planPickClick(at({shift: true, toggle: true, hasPick: true})).action, 'extend')
  assert.equal(planPickClick(at({toggle: true, hasPick: true})).action, 'toggle')
})
