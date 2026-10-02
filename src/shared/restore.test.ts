import {test} from 'node:test'
import assert from 'node:assert/strict'
import {applyExclusions, planRestore, type RestorePlan} from './restore'
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

/** 只看「分组名 + 组内 url」，断言读起来与旧版一致，但 id 仍可单独断言。 */
const shape = (plan: RestorePlan) =>
  plan.items.map((item) => ({title: item.title, urls: item.bookmarks.map((bookmark) => bookmark.url)}))

const allUrls = (plan: RestorePlan) => plan.items.flatMap((item) => item.bookmarks.map((b) => b.url))

test('子文件夹成组，散装书签留在原位（按子级顺序）', () => {
  assert.deepEqual(shape(planRestore(session())), [
    {title: '工作', urls: ['https://a.com']},
    {title: '', urls: ['https://loose.com']},
    {title: '阅读', urls: ['https://c.com']},
    {title: '', urls: ['https://tail.com']}
  ])
})

test('每条书签都带 id，界面才能把勾选映射回具体标签', () => {
  const {items} = planRestore(session())

  assert.deepEqual(
    items[0].bookmarks.map((bookmark) => bookmark.id),
    ['b1'],
    '内部页面被跳过，剩下的书签 id 应原样带出'
  )
  assert.deepEqual(
    items.map((item) => item.folderId),
    ['g1', undefined, 'g3', undefined],
    '分组项带子文件夹 id，散装书签项没有'
  )
})

test('散装书签的 title 是空串，表示这些标签不建分组', () => {
  const loose = planRestore(session()).items.filter((item) => item.title === '')

  assert.equal(loose.length, 2)
  assert.deepEqual(
    loose.flatMap((item) => item.bookmarks.map((bookmark) => bookmark.url)),
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

  assert.deepEqual(shape(planRestore(node)), [
    {title: '', urls: ['https://a.com', 'https://b.com']},
    {title: '工作', urls: ['https://c.com']},
    {title: '', urls: ['https://d.com']}
  ])
})

test('内部页面计入 skipped，不会静默丢标签', () => {
  const {items, skipped} = planRestore(session())

  // chrome:// 一条 + 内层文件夹一条
  assert.equal(skipped, 2)
  assert.ok(!allUrls({items, skipped}).includes('chrome://settings'))
})

test('空子文件夹不产生项', () => {
  assert.ok(!planRestore(session()).items.some((item) => item.title === '空分组'))
})

test('只处理一层，更深的嵌套被跳过而不是被平铺', () => {
  assert.ok(!allUrls(planRestore(session())).includes('https://deep.com'))
})

test('没有分组的存档还原时也不会凭空造出分组', () => {
  // captureCurrentWindow 在窗口无分组时把标签直接放进会话文件夹，这里是它的对称输入。
  const flat = folder('s', '2026-10-02 14_30', [
    link('b1', 'https://a.com'),
    link('b2', 'https://b.com')
  ])

  assert.deepEqual(shape(planRestore(flat)), [
    {title: '', urls: ['https://a.com', 'https://b.com']}
  ])
})

test('空文件夹与全内部页面的文件夹都得到空计划', () => {
  assert.deepEqual(planRestore(folder('s', '空')).items, [])

  const {items, skipped} = planRestore(folder('s', '全内部', [link('b1', 'chrome://newtab')]))
  assert.deepEqual(items, [])
  assert.equal(skipped, 1)
})

test('planRestore 不修改传入的书签树', () => {
  const node = session()
  const before = JSON.stringify(node)

  planRestore(node)

  assert.equal(JSON.stringify(node), before)
})

test('applyExclusions 只剔除被勾掉的书签，其余原样保留', () => {
  const plan = planRestore(session())

  const trimmed = applyExclusions(plan, new Set(['b3']))

  assert.deepEqual(shape(trimmed), [
    {title: '工作', urls: ['https://a.com']},
    {title: '阅读', urls: ['https://c.com']},
    {title: '', urls: ['https://tail.com']}
  ])
  assert.equal(trimmed.skipped, plan.skipped, 'skipped 不该被排除操作改动')
})

test('整组被勾掉时该项消失，而不是留下一个空分组', () => {
  const trimmed = applyExclusions(planRestore(session()), new Set(['b1', 'b4']))

  assert.deepEqual(shape(trimmed), [
    {title: '', urls: ['https://loose.com']},
    {title: '', urls: ['https://tail.com']}
  ])
})

test('全部勾掉得到空计划，还原时不会开任何标签', () => {
  const plan = planRestore(session())
  const everything = new Set(plan.items.flatMap((item) => item.bookmarks.map((b) => b.id)))

  assert.deepEqual(applyExclusions(plan, everything).items, [])
})

test('没有排除项时原样返回同一个计划，不做无谓复制', () => {
  const plan = planRestore(session())

  assert.equal(applyExclusions(plan, undefined), plan)
  assert.equal(applyExclusions(plan, new Set()), plan)
})
