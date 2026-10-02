import {test} from 'node:test'
import assert from 'node:assert/strict'
import {planRestore} from './restore'
import {UNGROUPED_FOLDER_NAME} from './naming'
import type {BookmarkNode, RestoreOptions} from './types'

const folder = (id: string, title: string, children: BookmarkNode[] = []): BookmarkNode => ({
  id,
  title,
  children
})

const link = (id: string, url: string): BookmarkNode => ({id, title: url, url})

/** 一次「有分组」的保存结果，见 docs/design.md §三。 */
const session = (): BookmarkNode =>
  folder('s', '2026-10-02 14:30', [
    folder('g1', '工作', [link('b1', 'https://a.com'), link('b2', 'chrome://settings')]),
    folder('g2', '空分组'),
    folder('g3', '深层', [folder('g4', '内层', [link('b3', 'https://c.com')])]),
    link('b4', 'https://loose.com'),
    link('b5', 'chrome-extension://abc/page.html')
  ])

const plan = (node: BookmarkNode, options: Partial<RestoreOptions> = {}) =>
  planRestore(node, {target: 'newWindow', groupUngrouped: false, ...options})

test('一层子文件夹各建一个分组，顺序与书签树一致', () => {
  const {groups} = plan(session())
  // 「工作」来自子文件夹；末尾的空 title 是顶层散装书签那一组。
  // 空分组、深层嵌套都被排除在外。
  assert.deepEqual(
    groups.map((group) => group.title),
    ['工作', '']
  )
  assert.deepEqual(groups[0].urls, ['https://a.com'])
})

test('内部页面计入 skipped，不会静默丢标签', () => {
  const {groups, skipped} = plan(session())
  // chrome:// 一条 + 内层文件夹一条 + chrome-extension:// 一条
  assert.equal(skipped, 3)
  const allUrls = groups.flatMap((group) => group.urls)
  assert.ok(!allUrls.includes('chrome://settings'))
  assert.ok(!allUrls.includes('chrome-extension://abc/page.html'))
})

test('空子文件夹不产生分组', () => {
  const {groups} = plan(session())
  assert.ok(!groups.some((group) => group.title === '空分组'))
})

test('只处理一层，更深的嵌套被跳过而不是被平铺', () => {
  const {groups} = plan(session())
  const allUrls = groups.flatMap((group) => group.urls)
  assert.ok(!allUrls.includes('https://c.com'), '子文件夹的子文件夹不应递归展开')
})

test('顶层散装书签默认不建分组（title 为空串）', () => {
  const {groups} = plan(session())
  const loose = groups.at(-1)
  assert.equal(loose?.title, '')
  assert.deepEqual(loose?.urls, ['https://loose.com'])
})

test('groupUngrouped 打开时散装书签进「未分组」', () => {
  const {groups} = plan(session(), {groupUngrouped: true})
  const loose = groups.at(-1)
  assert.equal(loose?.title, UNGROUPED_FOLDER_NAME)
  assert.deepEqual(loose?.urls, ['https://loose.com'])
})

test('没有分组的存档还原时也不会凭空造出分组', () => {
  // captureCurrentWindow 在窗口无分组时把书签直接放进会话文件夹，这里是它的对称输入。
  const flat = folder('s', '2026-10-02 14:30', [
    link('b1', 'https://a.com'),
    link('b2', 'https://b.com')
  ])
  const {groups} = plan(flat)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].title, '', '空 title 意味着 applyGroups 不会建分组')
  assert.deepEqual(groups[0].urls, ['https://a.com', 'https://b.com'])
})

test('空文件夹与全内部页面的文件夹都得到空计划', () => {
  assert.deepEqual(plan(folder('s', '空')).groups, [])

  const internal = folder('s', '全内部', [link('b1', 'chrome://newtab')])
  const {groups, skipped} = plan(internal)
  assert.deepEqual(groups, [])
  assert.equal(skipped, 1)
})

test('planRestore 不修改传入的书签树', () => {
  const node = session()
  const before = JSON.stringify(node)
  plan(node)
  assert.equal(JSON.stringify(node), before)
})
