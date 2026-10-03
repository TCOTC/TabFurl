import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FOLDER_NAME_LENGTH,
  formatTimestamp,
  groupFolderName,
  sanitizeFolderName
} from './naming'

test('formatTimestamp 用本地时间并补齐两位', () => {
  // 传本地时间构造的 Date（月从 0 起），得到的一定是同一个墙上时间，与运行机器的时区无关。
  assert.equal(formatTimestamp(new Date(2026, 9, 2, 23, 51)), '2026-10-02 23:51')
  assert.equal(formatTimestamp(new Date(2026, 0, 5, 9, 7)), '2026-01-05 09:07')
})

test('formatTimestamp 的形态能被 sanitizeFolderName 原样通过', () => {
  // 冒号是合法的书签名，默认名不该被清洗改掉，否则「时间戳」看起来就不像时间了。
  const name = formatTimestamp(new Date(2026, 9, 2, 23, 51))
  assert.equal(sanitizeFolderName(name, 'x'), name)
})

test('sanitizeFolderName 折叠连续空白并去掉首尾空白', () => {
  assert.equal(sanitizeFolderName('  a   b  ', 'x'), 'a b')
})

test('sanitizeFolderName 把控制字符替换成空格', () => {
  assert.equal(sanitizeFolderName('a\u0000b\u001fc', 'x'), 'a b c')
})

test('sanitizeFolderName 保留可打印字符原文', () => {
  // Chrome 不禁这些字符，本项目的清洗不做路径替换。
  assert.equal(sanitizeFolderName('a/b\\c:d*e?f"g<h>i|j', 'x'), 'a/b\\c:d*e?f"g<h>i|j')
  assert.equal(sanitizeFolderName('会议 / 一期', 'x'), '会议 / 一期')
})

test('sanitizeFolderName 清洗后为空时使用 fallback', () => {
  assert.equal(sanitizeFolderName('', 'fallback'), 'fallback')
  assert.equal(sanitizeFolderName('   ', 'fallback'), 'fallback')
  assert.equal(sanitizeFolderName('\u0000\u001f', 'fallback'), 'fallback')
})

test('sanitizeFolderName 截断到上限并去掉截断处的尾随空白', () => {
  assert.equal(sanitizeFolderName('x'.repeat(150), 'f').length, MAX_FOLDER_NAME_LENGTH)

  // 第 100 个字符正好是空格，截断后应被 trimEnd 去掉。
  const raw = `${'a'.repeat(99)} ${'b'.repeat(10)}`
  assert.equal(sanitizeFolderName(raw, 'f'), 'a'.repeat(99))
})

test('groupFolderName 用分组标题原文', () => {
  assert.equal(groupFolderName({title: '工作'}), '工作')
  assert.equal(groupFolderName({title: 'a/b', color: 'blue'}), 'a/b')
})

test('groupFolderName 空标题时用颜色消歧', () => {
  assert.equal(groupFolderName({title: '', color: 'blue'}), '未命名分组（蓝）')
  assert.equal(groupFolderName({title: '   ', color: 'orange'}), '未命名分组（橙）')
  // 颜色缺失时也给出确定的名字，不留空文件夹名。
  assert.equal(groupFolderName({title: ''}), '未命名分组（无颜色）')
})

test('同名分组不会被改名，也不会被去重', () => {
  // 同名允许共存是刻意的（见 docs/design.md 三）：书签树本就允许同级同名，
  // 而且用户在不同窗口里可能真的有两个叫「工作」的分组。
  // 这里顺带钉住「命名层里没有去重逻辑」，防止它被顺手加回来。
  const name = groupFolderName({title: '工作'})
  assert.equal(name, '工作')
  assert.equal(groupFolderName({title: '工作'}), '工作')
  assert.ok(!/[(（]2[)）]/.test(name), '不得追加序号')
})
