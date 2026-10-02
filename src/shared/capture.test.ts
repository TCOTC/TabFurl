import {test} from 'node:test'
import assert from 'node:assert/strict'
import {captureCurrentWindow, snapshotCurrentWindow} from './capture'
import {UNGROUPED_FOLDER_NAME} from './naming'

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

  const result = await captureCurrentWindow(ARCHIVE_ROOT, 'datetime')

  assert.deepEqual(result, {
    folderId: '',
    folderName: '',
    saved: 0,
    skipped: 2,
    groups: 0
  })
  assert.equal(created.length, 0, '不应产生任何书签写入')
})

test('窗口内没有分组时省略桶层，书签直接放进会话文件夹', async () => {
  const {created} = stubChrome([plainTab(1, 'https://a.com'), plainTab(2, 'https://b.com')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT, 'datetime')

  const folders = foldersOf(created)
  assert.equal(folders.length, 1, '只应有会话文件夹这一层')
  assert.equal(folders[0].parentId, ARCHIVE_ROOT)
  // `sanitizeFolderName` 会把 `:` 换成 `_`（为将来导出为文件路径留后路），
  // 所以真实写入书签的名字是 `2026-10-02 21_44`，而不是设计文档示例里的 `21:44`。
  assert.match(folders[0].title, /^\d{4}-\d{2}-\d{2} \d{2}_\d{2}$/)

  const links = linksOf(created)
  assert.equal(links.length, 2)
  assert.ok(links.every((node) => node.parentId === folders[0].id))

  assert.equal(result.saved, 2)
  assert.equal(result.groups, 0)
  assert.equal(result.folderId, folders[0].id)
})

test('有分组时建桶层，未分组标签进「未分组」文件夹', async () => {
  const {created} = stubChrome(
    [
      plainTab(1, 'https://a.com', {groupId: 10}),
      plainTab(2, 'https://b.com', {groupId: 10}),
      plainTab(3, 'https://c.com')
    ],
    {groups: {10: {title: '工作', color: 'blue'}}}
  )

  const result = await captureCurrentWindow(ARCHIVE_ROOT, 'datetime')

  const folders = foldersOf(created)
  assert.equal(folders.length, 3, '会话 + 工作 + 未分组')

  const work = folders.find((node) => node.title === '工作')
  const ungrouped = folders.find((node) => node.title === UNGROUPED_FOLDER_NAME)
  assert.ok(work && ungrouped, '两个桶都要建出来')

  const links = linksOf(created)
  assert.equal(links.filter((node) => node.parentId === work.id).length, 2)
  assert.equal(links.filter((node) => node.parentId === ungrouped.id).length, 1)

  assert.equal(result.saved, 3)
  // groups 只数真正的标签分组，不含「未分组」桶（它是收纳层，不是用户建的分组）。
  assert.equal(result.groups, 1)
})

test('两个同名标签分组不互相覆盖，第二个追加序号', async () => {
  const {created} = stubChrome(
    [plainTab(1, 'https://a.com', {groupId: 10}), plainTab(2, 'https://b.com', {groupId: 11})],
    {groups: {10: {title: '工作', color: 'blue'}, 11: {title: '工作', color: 'red'}}}
  )

  const result = await captureCurrentWindow(ARCHIVE_ROOT, 'datetime')

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

  await captureCurrentWindow(ARCHIVE_ROOT, 'datetime')

  const names = foldersOf(created).map((node) => node.title)
  assert.ok(names.includes('未命名分组（蓝）'))
  assert.ok(names.includes('未命名分组（无颜色）'), '未知颜色不应拼出奇怪的名字')
})

test('datetimeSite 模式把活动标签的站点写进会话名', async () => {
  const {created} = stubChrome([plainTab(1, 'https://www.github.com/user/repo')])

  const result = await captureCurrentWindow(ARCHIVE_ROOT, 'datetimeSite')

  assert.match(result.folderName, /^\d{4}-\d{2}-\d{2} \d{2}_\d{2} · github\.com$/u)
  assert.equal(created.filter((node) => node.url === undefined).length, 1)
})

test('会话文件夹与已有文件夹重名时追加序号', async (t) => {
  t.mock.timers.enable({apis: ['Date'], now: new Date(2026, 9, 2, 14, 30)})
  t.after(() => t.mock.timers.reset())

  const {created} = stubChrome([plainTab(1, 'https://a.com')], {
    // 种子用的是清洗后的形态（冒号已成下划线），即真实写入书签的名字。
    seed: {[ARCHIVE_ROOT]: [{id: 'old', title: '2026-10-02 14_30'}]}
  })

  const result = await captureCurrentWindow(ARCHIVE_ROOT, 'datetime')

  assert.equal(result.folderName, '2026-10-02 14_30 (2)')
  assert.equal(created.length, 2, '会话文件夹 + 一个书签')
})
