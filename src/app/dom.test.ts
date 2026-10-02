import {test} from 'node:test'
import assert from 'node:assert/strict'
import {nextSelectAll, triState} from './dom'

test('triState：全选、部分、全不选', () => {
  assert.equal(triState(5, 5), 'all')
  assert.equal(triState(3, 5), 'some')
  assert.equal(triState(0, 5), 'none')
})

test('triState：没有可勾的项时算 none，而不是全选', () => {
  // 这条最容易写错：`kept === total`（都是 0）会被误判成全选。
  assert.equal(triState(0, 0), 'none')
})

test('triState：保留数超过总数也只会是全选，不越界', () => {
  assert.equal(triState(7, 5), 'all')
})

test('nextSelectAll：全选时点一下变全不选，其余情况都变全选', () => {
  assert.equal(nextSelectAll('all'), false)
  assert.equal(nextSelectAll('some'), true)
  assert.equal(nextSelectAll('none'), true)
})

test('部分状态点击结果与原生取反行为相反，所以必须自己推', () => {
  // 原生行为：清除 indeterminate 并把 checked 取反。部分状态下 checked 为真，
  // 取反会得到「全不选」；而惯例（Windows 资源管理器）是「干脆全要」。
  const nativeFlipResult = false
  assert.equal(nextSelectAll('some'), true)
  assert.notEqual(nextSelectAll('some'), nativeFlipResult, '不能沿用原生取反的结果')
})