import {test} from 'node:test'
import assert from 'node:assert/strict'
import {canDropTo, dropTargetId} from './archiveDrop'

/** 树：a > (a1, a2 > a2x)；b；c */
const parents = new Map<string, string>([
  ['a', 'root'],
  ['a1', 'a'],
  ['a2', 'a'],
  ['a2x', 'a2'],
  ['b', 'root'],
  ['c', 'root']
])

test('canDropTo：非文件夹载荷一律放行（书签、记号、一批选择都不会成环）', () => {
  assert.equal(canDropTo({kind: 'bookmark', id: 'a'}, 'a', parents), true)
  assert.equal(canDropTo({kind: 'separator', id: 'a'}, 'a', parents), true)
  assert.equal(canDropTo({kind: 'selection', ids: ['a']}, 'a', parents), true)
  assert.equal(canDropTo({kind: 'tab', tabId: 1}, 'a', parents), true)
})

test('canDropTo：拖到自己身上不收', () => {
  assert.equal(canDropTo({kind: 'folder', id: 'a'}, 'a', parents), false)
})

test('canDropTo：拖进自己的子孙不收（会成环）', () => {
  assert.equal(canDropTo({kind: 'folder', id: 'a'}, 'a2', parents), false)
  assert.equal(canDropTo({kind: 'folder', id: 'a'}, 'a2x', parents), false)
})

test('canDropTo：拖进兄弟或无关键可以', () => {
  assert.equal(canDropTo({kind: 'folder', id: 'a'}, 'b', parents), true)
  assert.equal(canDropTo({kind: 'folder', id: 'a2'}, 'a', parents), true)
})

test('canDropTo：插到「a 里面的某条」旁边，收件层仍然是 a 本身 → 拒收', () => {
  // 书签行只能「插前 / 插后」，而 `dropTargetId` 给的是**它所在的那一层**（不是书签自己）。
  // 所以把 a 拖到 a1 旁边 = 往 a 里面插 a → 成环。这是实测踩到过的那条「拖了但没动」。
  assert.equal(canDropTo({kind: 'folder', id: 'a'}, 'a', parents), false)
})

test('dropTargetId：into 收的是那个文件夹本身', () => {
  assert.equal(dropTargetId({kind: 'into', folderId: 'a2'}), 'a2')
})

test('dropTargetId：here 收的是**它所在的那一层**（展开后两者不是一回事）', () => {
  assert.equal(dropTargetId({kind: 'here', parentId: 'a', index: 3, after: false}), 'a')
})
