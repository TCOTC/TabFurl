import {test} from 'node:test'
import assert from 'node:assert/strict'
import {planRestore} from './restore'
import type {BookmarkNode} from './types'

const folder = (id: string, title: string, children: BookmarkNode[] = []): BookmarkNode => ({
  id,
  title,
  children
})

const link = (id: string, url: string): BookmarkNode => ({id, title: url, url})

/**
 * 一次「有分组」的保存结果。会话文件夹的子级按窗口顺序穿插：
 * 分组是子文件夹，未分组的标签是散装书签。
 */
const session = (): BookmarkNode =>
  folder('s', '2026-10-02 14_30', [
    folder('g1', '工作', [link('b1', 'https://a.com'), link('b2', 'chrome://settings')]),
    link('b3', 'https://loose.com'),
    folder('g3', '阅读', [link('b4', 'https://c.com')]),
    link('b5', 'https://tail.com'),
    folder('g2', '空分组'),
    folder('g4', '深层', [folder('g5', '内层', [link('b6', 'https://deep.com')])])
  ])

test('子文件夹成组，散装书签留在原位（按子级顺序）', () => {
  const {items} = planRestore(session())

  assert.deepEqual(items, [
    {title: '工作', urls: ['https://a.com']},
    {title: '', urls: ['https://loose.com']},
    {title: '阅读', urls: ['https://c.com']},
    {title: '', urls: ['https://tail.com']}
  ])
})

test('散装书签的 title 是空串，表示这些标签不建分组', () => {
  const {items} = planRestore(session())
  const loose = items.filter((item) => item.title === '')
  assert.equal(loose.length, 2)
  assert.deepEqual(
    loose.flatMap((item) => item.urls),
    ['https://loose.com', 'https://tail.com']
  )
})

test('相邻的散装书签合并成一项，但不跨越分组', () => {
  const node = folder('s', 's', [
    link('b1', 'https://a.com'),
    link('b2', 'https://b.com'),
    folder('g1', '工作', [link('b3', 'https://c.com')]),
    link('b4', 'https://d.com')
  ])

  assert.deepEqual(planRestore(node).items, [
    {title: '', urls: ['https://a.com', 'https://b.com']},
    {title: '工作', urls: ['https://c.com']},
    {title: '', urls: ['https://d.com']}
  ])
})

test('内部页面计入 skipped，不会静默丢标签', () => {
  const {items, skipped} = planRestore(session())

  // chrome:// 一条 + 内层文件夹一条
  assert.equal(skipped, 2)
  const allUrls = items.flatMap((item) => item.urls)
  assert.ok(!allUrls.includes('chrome://settings'))
})

test('空子文件夹不产生项', () => {
  const {items} = planRestore(session())
  assert.ok(!items.some((item) => item.title === '空分组'))
})

test('只处理一层，更深的嵌套被跳过而不是被平铺', () => {
  const {items} = planRestore(session())
  const allUrls = items.flatMap((item) => item.urls)
  assert.ok(!allUrls.includes('https://deep.com'), '子文件夹的子文件夹不应递归展开')
})

test('没有分组的存档还原时也不会凭空造出分组', () => {
  // captureCurrentWindow 在窗口无分组时把标签直接放进会话文件夹，这里是它的对称输入。
  const flat = folder('s', '2026-10-02 14_30', [
    link('b1', 'https://a.com'),
    link('b2', 'https://b.com')
  ])

  const {items} = planRestore(flat)

  assert.deepEqual(items, [{title: '', urls: ['https://a.com', 'https://b.com']}])
})

test('空文件夹与全内部页面的文件夹都得到空计划', () => {
  assert.deepEqual(planRestore(folder('s', '空')).items, [])

  const internal = folder('s', '全内部', [link('b1', 'chrome://newtab')])
  const {items, skipped} = planRestore(internal)
  assert.deepEqual(items, [])
  assert.equal(skipped, 1)
})

test('planRestore 不修改传入的书签树', () => {
  const node = session()
  const before = JSON.stringify(node)

  planRestore(node)

  assert.equal(JSON.stringify(node), before)
})
