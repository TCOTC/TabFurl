import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeSaveResults,
  planWindowChildren,
  selectTabs,
  snapshotCurrentWindow,
  writeChildren
} from './capture'

interface StubTab {
  /**
   * 它同时被当作 `TabSnapshot` 用（分组里的标签直接来自快照），
   * 所以字段取快照的形态、且都是必填。
   */
  tabId: number
  id: number
  windowId: number
  groupId: number
  index: number
  pinned: boolean
  title: string
  url: string
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
 * `bookmarks.create` 会把新节点挂回内存树，所以可以验证「写进已有文件夹」时是否真的落在正确的父级下。
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
    tabs: {query: async () => tabs},
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

/** 某个文件夹的直接子级，按写入顺序。 */
const childrenOf = (created: CreatedNode[], parentId: string) =>
  created.filter((node) => node.parentId === parentId)

/** 把子级压成可读的序列，便于断言穿插顺序。 */
const shape = (children: CreatedNode[]) =>
  children.map((node) => (node.url ? `书签:${node.url}` : `文件夹:${node.title}`))

const plainTab = (
  id: number,
  url: string,
  extra: {groupId?: number; pinned?: boolean} = {}
): StubTab => ({
  tabId: id,
  id,
  windowId: 7,
  groupId: extra.groupId ?? -1,
  index: id,
  pinned: extra.pinned ?? false,
  title: url,
  url
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

test('内部页面在快照阶段就被过滤，写不进去', async () => {
  stubChrome([plainTab(1, 'chrome://newtab'), plainTab(2, 'edge://settings')])

  const snapshot = await snapshotCurrentWindow()

  assert.equal(snapshot.groups.length, 0)
  assert.equal(snapshot.ungrouped.length, 0)
  assert.equal(snapshot.skipped, 2)
})

test('窗口内没有分组时，子级就是一列散装标签，顺序即窗口顺序', async () => {
  stubChrome([plainTab(1, 'https://a.com'), plainTab(2, 'https://b.com')])

  const children = planWindowChildren(await snapshotCurrentWindow())

  assert.deepEqual(
    children.map((child) => (child.kind === 'tab' ? child.tab.url : `组:${child.name}`)),
    ['https://a.com', 'https://b.com']
  )
})

test('未分组的标签按窗口顺序穿插在分组之间，不单独建文件夹', async () => {
  stubChrome(
    [
      plainTab(1, 'https://a1.com', {groupId: 10}),
      plainTab(2, 'https://a2.com', {groupId: 10}),
      plainTab(3, 'https://loose-1.com'),
      plainTab(4, 'https://b1.com', {groupId: 11}),
      plainTab(5, 'https://loose-2.com')
    ],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '阅读', color: 'red'}}}
  )

  const children = planWindowChildren(await snapshotCurrentWindow())

  assert.deepEqual(
    children.map((child) => (child.kind === 'tab' ? `书签:${child.tab.url}` : `文件夹:${child.name}`)),
    ['文件夹:工作', '书签:https://loose-1.com', '文件夹:阅读', '书签:https://loose-2.com'],
    '子级必须按窗口顺序穿插',
    // 不再有「未分组」文件夹。
  )
  assert.ok(!children.some((child) => child.kind === 'group' && child.name === '未分组'))

  const work = children.find((child) => child.kind === 'group' && child.name === '工作')
  assert.deepEqual(
    work?.kind === 'group' ? work.tabs.map((tab) => tab.url) : [],
    ['https://a1.com', 'https://a2.com'],
    '分组内部的标签顺序与窗口一致'
  )
})

test('窗口开头的未分组标签排在第一个分组前面', async () => {
  stubChrome(
    [plainTab(1, 'https://first.com'), plainTab(2, 'https://a.com', {groupId: 10})],
    {groups: {10: {title: '工作', color: 'blue'}}}
  )

  const children = planWindowChildren(await snapshotCurrentWindow())

  assert.deepEqual(
    children.map((child) => (child.kind === 'tab' ? `书签:${child.tab.url}` : `文件夹:${child.name}`)),
    ['书签:https://first.com', '文件夹:工作']
  )
})

test('空标题分组用颜色消歧，未知颜色退化为「无颜色」', async () => {
  stubChrome(
    [plainTab(1, 'https://a.com', {groupId: 10}), plainTab(2, 'https://b.com', {groupId: 11})],
    {groups: {10: {title: '', color: 'blue'}, 11: {title: '', color: 'magenta'}}}
  )

  const names = planWindowChildren(await snapshotCurrentWindow())
    .filter((child) => child.kind === 'group')
    .map((child) => (child.kind === 'group' ? child.name : ''))

  assert.ok(names.includes('未命名分组（蓝）'))
  assert.ok(names.includes('未命名分组（无颜色）'), '未知颜色不应拼出奇怪的名字')
})

test('writeChildren 把分组写成子文件夹，散装标签留在那一层', async () => {
  const {created} = stubChrome([])

  const result = await writeChildren(ARCHIVE_ROOT, [
    {kind: 'group', name: '工作', tabs: [plainTab(1, 'https://a1.com'), plainTab(2, 'https://a2.com')]},
    {kind: 'tab', tab: plainTab(3, 'https://loose.com')}
  ])

  assert.deepEqual(shape(childrenOf(created, ARCHIVE_ROOT)), ['文件夹:工作', '书签:https://loose.com'])
  const work = foldersOf(created)[0]
  assert.deepEqual(shape(childrenOf(created, work.id)), [
    '书签:https://a1.com',
    '书签:https://a2.com'
  ])
  assert.equal(result.saved, 3)
  assert.equal(result.groups, 1)
})

test('writeChildren 能写进任意一层——拖到某个分组文件夹上就进那一层', async () => {
  const {created} = stubChrome([])

  await writeChildren('some-existing-folder', [{kind: 'tab', tab: plainTab(1, 'https://a.com')}])

  assert.deepEqual(
    created.map((node) => `${node.parentId}:${node.title}`),
    ['some-existing-folder:https://a.com'],
    '父级必须是调用方给的文件夹，而不是存档根'
  )
})

test('拖一条标签过来就是只写一个 tab 子级', async () => {
  const {created} = stubChrome([])

  const result = await writeChildren(ARCHIVE_ROOT, [{kind: 'tab', tab: plainTab(7, 'https://one.com')}])

  assert.equal(result.saved, 1)
  assert.equal(result.groups, 0)
  assert.equal(created.length, 1)
})

test('同名分组允许共存：不合并、也不追加序号', async () => {
  const {created} = stubChrome([])

  await writeChildren(ARCHIVE_ROOT, [
    {kind: 'group', name: '工作', tabs: [plainTab(1, 'https://a.com')]},
    {kind: 'group', name: '工作', tabs: [plainTab(2, 'https://b.com')]}
  ])

  const names = foldersOf(created).map((node) => node.title)
  assert.deepEqual(names, ['工作', '工作'], '两个同名文件夹各自独立')
  assert.equal(new Set(foldersOf(created).map((node) => node.id)).size, 2, '不是同一个文件夹')
})

test('writeChildren 收集新建的 id，供撤销使用', async () => {
  const {created} = stubChrome([])

  const result = await writeChildren(ARCHIVE_ROOT, [
    {kind: 'group', name: '工作', tabs: [plainTab(1, 'https://a.com')]},
    {kind: 'tab', tab: plainTab(2, 'https://b.com')}
  ])

  const work = foldersOf(created)[0]
  assert.deepEqual(result.folderIds, [work.id])
  assert.deepEqual(
    result.bookmarkIds,
    created.filter((node) => node.url !== undefined).map((node) => node.id),
    '书签 id 要与实际写入的一一对应'
  )
})

test('什么都不拖时不写入任何东西', async () => {
  const {created} = stubChrome([])

  const result = await writeChildren(ARCHIVE_ROOT, [])

  assert.deepEqual(result, {
    saved: 0,
    groups: 0,
    skipped: 0,
    folderIds: [],
    bookmarkIds: []
  })
  assert.equal(created.length, 0)
})

test('mergeSaveResults 合并多次写入（一次动作可能写了好几处）', () => {
  const a = {saved: 1, groups: 0, skipped: 0, folderIds: [], bookmarkIds: ['b1']}
  const b = {saved: 2, groups: 1, skipped: 3, folderIds: ['f1'], bookmarkIds: ['b2', 'b3']}

  assert.deepEqual(mergeSaveResults([a, b]), {
    saved: 3,
    groups: 1,
    skipped: 3,
    folderIds: ['f1'],
    bookmarkIds: ['b1', 'b2', 'b3']
  })
  assert.deepEqual(mergeSaveResults([]), {
    saved: 0,
    groups: 0,
    skipped: 0,
    folderIds: [],
    bookmarkIds: []
  })
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

test('只写入勾选的标签，整组勾掉就不建那个文件夹', async () => {
  stubChrome(
    [
      plainTab(1, 'https://a1.com', {groupId: 10}),
      plainTab(2, 'https://a2.com', {groupId: 10}),
      plainTab(3, 'https://loose.com'),
      plainTab(4, 'https://b1.com', {groupId: 11})
    ],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '阅读', color: 'red'}}}
  )

  const snapshot = selectTabs(await snapshotCurrentWindow(), new Set([2, 4]))
  const {created} = stubChrome([])
  const result = await writeChildren(ARCHIVE_ROOT, planWindowChildren(snapshot))

  assert.deepEqual(shape(childrenOf(created, ARCHIVE_ROOT)), ['文件夹:工作', '书签:https://loose.com'])
  assert.equal(result.saved, 2)
  assert.equal(result.groups, 1, '被勾掉的「阅读」不该建文件夹')
})

test('全部勾掉时不写入任何东西', async () => {
  stubChrome([plainTab(1, 'https://a.com')])

  const snapshot = selectTabs(await snapshotCurrentWindow(), new Set([1]))
  const {created} = stubChrome([])
  const result = await writeChildren(ARCHIVE_ROOT, planWindowChildren(snapshot))

  assert.equal(result.saved, 0)
  assert.equal(result.groups, 0)
  assert.equal(created.length, 0)
})
