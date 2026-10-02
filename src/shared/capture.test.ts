import {test} from 'node:test'
import assert from 'node:assert/strict'
import {captureCurrentWindow, selectTabs, snapshotCurrentWindow} from './capture'

interface StubTab {
  id: number
  windowId?: number
  groupId?: number
  index: number
  pinned?: boolean
  title: string
  url: string
  lastAccessed?: number
}

interface StubNode {
  id: string
  title: string
  url?: string
}

interface CreatedNode extends StubNode {
  parentId: string
}

const ARCHIVE_ROOT = 'root-1'

/**
 * 用内存书签树 + 固定标签列表替换 `chrome.*`。
 *
 * `bookmarks.create` 会把新节点挂回内存树，所以 `dedupeName` 能看到「同一轮里刚建好的同名文件夹」，
 * 不必依赖时间或人为预设。
 */
function stubChrome(
  tabs: StubTab[],
  options: {groups?: Record<number, unknown>; seed?: Record<string, StubNode[]>} = {}
) {
  const tree: Record<string, StubNode[]> = {}
  for (const [parentId, nodes] of Object.entries(options.seed ?? {})) {
    tree[parentId] = nodes.map((node) => ({...node}))
  }

  const created: CreatedNode[] = []
  let seq = 0

  ;(globalThis as Record<string, unknown>).chrome = {
    tabs: {
      // activeSiteLabel 用 {active: true} 取当前活动标签。
      query: async (query?: {active?: boolean}) => (query?.active ? [tabs[0]] : tabs)
    },
    tabGroups: {get: async (id: number) => options.groups?.[id]},
    windows: {WINDOW_ID_CURRENT: -2},
    bookmarks: {
      getChildren: async (id: string) => (tree[id] ?? []).map((node) => ({...node})),
      create: async (input: {parentId: string; title: string; url?: string}) => {
        seq += 1
        const node: CreatedNode = {
          id: `new-${seq}`,
          parentId: input.parentId,
          title: input.title,
          url: input.url
        }
        ;(tree[input.parentId] ??= []).push({id: node.id, title: node.title, url: node.url})
        created.push(node)
        return {id: node.id, parentId: node.parentId, title: node.title, url: node.url}
      }
    }
  }

  return {created}
}

const foldersOf = (created: CreatedNode[]) => created.filter((node) => node.url === undefined)
const linksOf = (created: CreatedNode[]) => created.filter((node) => node.url !== undefined)

/** 会话文件夹的直接子级，按写入顺序。 */
const childrenOf = (created: CreatedNode[], sessionId: string) =>
  created.filter((node) => node.parentId === sessionId)

/** 把子级压成可读的序列，便于断言穿插顺序。 */
const shape = (children: CreatedNode[]) =>
  children.map((node) => (node.url ? `书签:${node.url}` : `文件夹:${node.title}`))

const plainTab = (id: number, url: string, extra: Partial<StubTab> = {}): StubTab => ({
  id,
  windowId: 7,
  groupId: -1,
  index: id,
  pinned: false,
  title: url,
  url,
  ...extra
})

test('snapshotCurrentWindow 按 groupId 分桶，不按标题合并', async () => {
  stubChrome(
    [
      plainTab(1, 'https://a.com', {groupId: 10}),
      plainTab(2, 'https://b.com', {groupId: 11, pinned: true}),
      plainTab(3, 'https://c.com'),
      plainTab(4, 'chrome://newtab')
    ],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '工作', color: 'red'}}}
  )

  const snapshot = await snapshotCurrentWindow()

  assert.equal(snapshot.windowId, 7)
  assert.equal(snapshot.groups.length, 2, '同名不同 groupId 必须是两个桶')
  assert.equal(snapshot.groups[0].color, 'blue')
  assert.equal(snapshot.groups[1].color, 'red')
  assert.equal(snapshot.ungrouped.length, 1)
  assert.equal(snapshot.skipped, 1)
})

test('分组元数据取不到时退化为空标题，不抛错', async () => {
  stubChrome([plainTab(1, 'https://a.com', {groupId: 99})])

  const snapshot = await snapshotCurrentWindow()

  assert.equal(snapshot.groups[0].title, '')
  assert.equal(snapshot.groups[0].color, undefined)
})

test('一个标签都存不了时不留下空文件夹', async () => {
  const {created} = stubChrome([plainTab(1, 'chrome://newtab'), plainTab(2, 'edge://settings')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT)

  assert.deepEqual(result, {
    folderId: '',
    folderName: '',
    saved: 0,
    skipped: 2,
    groups: 0
  })
  assert.equal(created.length, 0, '不应产生任何书签写入')
})

test('窗口内没有分组时，书签直接放进会话文件夹', async () => {
  const {created} = stubChrome([plainTab(1, 'https://a.com'), plainTab(2, 'https://b.com')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT)

  const folders = foldersOf(created)
  assert.equal(folders.length, 1, '只应有会话文件夹这一层')
  assert.equal(folders[0].parentId, ARCHIVE_ROOT)
  // `sanitizeFolderName` 会把 `:` 换成 `_`（为将来导出为文件路径留后路），
  // 所以真实写入书签的名字是 `2026-10-02 21_44`，而不是设计文档示例里的 `21:44`。
  assert.match(folders[0].title, /^\d{4}-\d{2}-\d{2} \d{2}_\d{2}$/)

  assert.deepEqual(shape(childrenOf(created, result.folderId)), [
    '书签:https://a.com',
    '书签:https://b.com'
  ])

  assert.equal(result.saved, 2)
  assert.equal(result.groups, 0)
  assert.equal(result.folderId, folders[0].id)
})

test('未分组的标签按窗口顺序穿插在分组之间，不单独建文件夹', async () => {
  const {created} = stubChrome(
    [
      plainTab(1, 'https://a1.com', {groupId: 10}),
      plainTab(2, 'https://a2.com', {groupId: 10}),
      plainTab(3, 'https://loose-1.com'),
      plainTab(4, 'https://b1.com', {groupId: 11}),
      plainTab(5, 'https://loose-2.com')
    ],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '阅读', color: 'red'}}}
  )

  const result = await captureCurrentWindow(ARCHIVE_ROOT)

  const children = childrenOf(created, result.folderId)
  assert.deepEqual(
    shape(children),
    [
      '文件夹:工作',
      '书签:https://loose-1.com',
      '文件夹:阅读',
      '书签:https://loose-2.com'
    ],
    '会话文件夹的子级必须按窗口顺序穿插'
  )

  // 不再有「未分组」文件夹。
  assert.ok(!children.some((node) => node.title === '未分组'))

  // 分组内部的标签顺序与窗口一致。
  const work = children.find((node) => node.title === '工作')
  assert.deepEqual(shape(childrenOf(created, work?.id ?? '')), [
    '书签:https://a1.com',
    '书签:https://a2.com'
  ])

  assert.equal(result.saved, 5)
  assert.equal(result.groups, 2)
})

test('窗口开头的未分组标签排在第一个分组前面', async () => {
  const {created} = stubChrome(
    [
      plainTab(1, 'https://first.com'),
      plainTab(2, 'https://a.com', {groupId: 10})
    ],
    {groups: {10: {title: '工作', color: 'blue'}}}
  )

  const result = await captureCurrentWindow(ARCHIVE_ROOT)

  assert.deepEqual(shape(childrenOf(created, result.folderId)), [
    '书签:https://first.com',
    '文件夹:工作'
  ])
})

test('两个同名标签分组不互相覆盖，第二个追加序号', async () => {
  const {created} = stubChrome(
    [plainTab(1, 'https://a.com', {groupId: 10}), plainTab(2, 'https://b.com', {groupId: 11})],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '工作', color: 'red'}}}
  )

  const result = await captureCurrentWindow(ARCHIVE_ROOT)

  const names = foldersOf(created)
    .filter((node) => node.parentId !== ARCHIVE_ROOT)
    .map((node) => node.title)
  assert.deepEqual(names, ['工作', '工作 (2)'])
  assert.equal(result.groups, 2)
})

test('空标题分组用颜色消歧，未知颜色退化为「无颜色」', async () => {
  const {created} = stubChrome(
    [plainTab(1, 'https://a.com', {groupId: 10}), plainTab(2, 'https://b.com', {groupId: 11})],
    {groups: {10: {title: '', color: 'blue'}, 11: {title: '', color: 'magenta'}}}
  )

  await captureCurrentWindow(ARCHIVE_ROOT)

  const names = foldersOf(created).map((node) => node.title)
  assert.ok(names.includes('未命名分组（蓝）'))
  assert.ok(names.includes('未命名分组（无颜色）'), '未知颜色不应拼出奇怪的名字')
})

test('会话名默认只有时间戳', async () => {
  stubChrome([plainTab(1, 'https://www.github.com/user/repo')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT)

  // 时间戳里的冒号会被清洗成下划线；不再把站点写进会话名。
  assert.match(result.folderName, /^\d{4}-\d{2}-\d{2} \d{2}_\d{2}$/)
  assert.ok(!result.folderName.includes('github'))
})

test('自定义名拼在时间戳前面，并过一遍清洗', async () => {
  stubChrome([plainTab(1, 'https://a.com')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT, {name: '季度归档 / 一期'})

  assert.match(result.folderName, /^季度归档 _ 一期 · \d{4}-\d{2}-\d{2} \d{2}_\d{2}$/)
})

test('自定义名只有空白时退回只用时间戳', async () => {
  stubChrome([plainTab(1, 'https://a.com')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT, {name: '   '})

  assert.match(result.folderName, /^\d{4}-\d{2}-\d{2} \d{2}_\d{2}$/)
})

test('带自定义名的会话重名时追加序号，时间戳不受影响', async (t) => {
  t.mock.timers.enable({apis: ['Date'], now: new Date(2026, 9, 2, 14, 30)})
  t.after(() => t.mock.timers.reset())

  const {created} = stubChrome([plainTab(1, 'https://a.com')], {
    seed: {[ARCHIVE_ROOT]: [{id: 'old', title: '会议 · 2026-10-02 14_30'}]}
  })

  const result = await captureCurrentWindow(ARCHIVE_ROOT, {name: '会议'})

  assert.equal(result.folderName, '会议 · 2026-10-02 14_30 (2)')
  assert.equal(created.length, 2, '会话文件夹 + 一个书签')
})

test('会话文件夹与已有文件夹重名时追加序号', async (t) => {
  t.mock.timers.enable({apis: ['Date'], now: new Date(2026, 9, 2, 14, 30)})
  t.after(() => t.mock.timers.reset())

  const {created} = stubChrome([plainTab(1, 'https://a.com')], {
    // 种子用的是清洗后的形态（冒号已成下划线），即真实写入书签的名字。
    seed: {[ARCHIVE_ROOT]: [{id: 'old', title: '2026-10-02 14_30'}]}
  })

  const result = await captureCurrentWindow(ARCHIVE_ROOT)

  assert.equal(result.folderName, '2026-10-02 14_30 (2)')
  assert.equal(created.length, 2, '会话文件夹 + 一个书签')
})

test('selectTabs 剔除被勾掉的标签，并丢掉因此变空的分组', async () => {
  stubChrome(
    [
      plainTab(1, 'https://a1.com', {groupId: 10}),
      plainTab(2, 'https://a2.com', {groupId: 10}),
      plainTab(3, 'https://loose.com'),
      plainTab(4, 'https://b1.com', {groupId: 11})
    ],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '阅读', color: 'red'}}}
  )

  const snapshot = await snapshotCurrentWindow()
  const kept = selectTabs(snapshot, new Set([2, 4, 3]))

  assert.equal(kept.groups.length, 1, '「阅读」整组被勾掉后应消失')
  assert.equal(kept.groups[0].title, '工作')
  assert.deepEqual(kept.groups[0].tabs.map((tab) => tab.url), ['https://a1.com'])
  assert.deepEqual(kept.ungrouped, [], '散装标签也被勾掉了')

  assert.equal(snapshot.groups.length, 2, 'selectTabs 不改动传入的快照')
  assert.equal(snapshot.ungrouped.length, 1)
})

test('没有排除项时 selectTabs 原样返回，不做无谓复制', async () => {
  stubChrome([plainTab(1, 'https://a.com')])

  const snapshot = await snapshotCurrentWindow()

  assert.equal(selectTabs(snapshot, new Set()), snapshot)
})

test('captureCurrentWindow 只写入勾选的标签，整组勾掉就不建那个文件夹', async () => {
  const {created} = stubChrome(
    [
      plainTab(1, 'https://a1.com', {groupId: 10}),
      plainTab(2, 'https://a2.com', {groupId: 10}),
      plainTab(3, 'https://loose.com'),
      plainTab(4, 'https://b1.com', {groupId: 11})
    ],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '阅读', color: 'red'}}}
  )

  const result = await captureCurrentWindow(ARCHIVE_ROOT, {
    excludeTabIds: new Set([2, 4])
  })

  assert.deepEqual(shape(childrenOf(created, result.folderId)), [
    '文件夹:工作',
    '书签:https://loose.com'
  ])
  assert.equal(result.saved, 2)
  assert.equal(result.groups, 1, '被勾掉的「阅读」不该建文件夹')
})

test('全部勾掉时不留下空文件夹', async () => {
  const {created} = stubChrome([plainTab(1, 'https://a.com')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT, {
    excludeTabIds: new Set([1])
  })

  assert.equal(result.saved, 0)
  assert.equal(result.folderId, '')
  assert.equal(created.length, 0)
})

test('自定义名不受勾选影响，被勾掉的标签不会跑到会话名里', async () => {
  // 存根里 query({active: true}) 返回 tabs[0]（活动标签），这里把它勾掉，
  // 会话名仍应只有我们自己给的名字 + 时间戳。
  stubChrome([plainTab(1, 'https://www.github.com/user/repo'), plainTab(2, 'https://b.com')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT, {
    name: '临时看的东西',
    excludeTabIds: new Set([1])
  })

  assert.match(result.folderName, /^临时看的东西 · \d{4}-/)
  assert.ok(!result.folderName.includes('github'))
})
