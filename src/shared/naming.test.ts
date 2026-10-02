import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FOLDER_NAME_LENGTH,
  dedupeName,
  formatSessionName,
  formatTimestamp,
  groupFolderName,
  sanitizeFolderName
} from './naming'

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

test('formatTimestamp 零填充且字典序等于时间序', () => {
  assert.equal(formatTimestamp(new Date(2026, 9, 2, 9, 5)), '2026-10-02 09:05')
  assert.equal(formatTimestamp(new Date(2026, 0, 1, 0, 0)), '2026-01-01 00:00')
  assert.equal(formatTimestamp(new Date(2026, 11, 31, 23, 59)), '2026-12-31 23:59')
})

test('formatSessionName 没有自定义名时只有时间戳', () => {
  const date = new Date(2026, 9, 2, 14, 30)
  assert.equal(formatSessionName(date), '2026-10-02 14:30')
  assert.equal(formatSessionName(date, ''), '2026-10-02 14:30')
  assert.equal(formatSessionName(date, '   '), '2026-10-02 14:30')
})

test('formatSessionName 把自定义名拼在时间戳前面', () => {
  const date = new Date(2026, 9, 2, 14, 30)
  assert.equal(formatSessionName(date, '会议'), '会议 · 2026-10-02 14:30')
  assert.equal(formatSessionName(date, '  会议  '), '会议 · 2026-10-02 14:30')
})

test('formatSessionName 保留手打原文', () => {
  const date = new Date(2026, 9, 2, 14, 30)
  assert.equal(formatSessionName(date, 'a/b:c'), 'a/b:c · 2026-10-02 14:30')
  assert.equal(formatSessionName(date, '项目/一期'), '项目/一期 · 2026-10-02 14:30')
})

test('名字过长时只截名字，不吞掉后面的时间戳', () => {
  const date = new Date(2026, 9, 2, 14, 30)
  const name = '很长的名字'.repeat(40)

  const result = formatSessionName(date, name)

  assert.ok(result.endsWith('· 2026-10-02 14:30'), `时间戳必须完整保留：${result}`)
  assert.ok(result.length <= MAX_FOLDER_NAME_LENGTH, `总长不能超上限：${result.length}`)
})

test('名字只剩控制字符时清洗后为空，退回只用时间戳', () => {
  const date = new Date(2026, 9, 2, 14, 30)
  assert.equal(formatSessionName(date, '\u0000\u001f'), '2026-10-02 14:30')
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

test('dedupeName 不冲突时原样返回', () => {
  assert.equal(dedupeName('工作', []), '工作')
  assert.equal(dedupeName('工作', ['阅读']), '工作')
})

test('dedupeName 依次追加 (2)、(3)，绝不覆盖', () => {
  assert.equal(dedupeName('工作', ['工作']), '工作 (2)')
  assert.equal(dedupeName('工作', ['工作', '工作 (2)']), '工作 (3)')
  assert.equal(dedupeName('工作', ['工作', '工作 (2)', '工作 (3)']), '工作 (4)')

  const existing = ['工作', '工作 (2)']
  const result = dedupeName('工作', existing)
  assert.ok(!existing.includes(result), '结果不得与同级已有名字重复')
})

test('dedupeName 对陷阱名字仍然可用（已有 (2) 但没有原名）', () => {
  assert.equal(dedupeName('工作', ['工作 (2)']), '工作')
})
