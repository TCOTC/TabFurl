import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  getBookmarksBarId,
  getNodePath,
  isRealBookmark,
  listArchiveRootCandidates,
  listFolders,
  realBookmarks
} from './bookmarks'
import {SEPARATOR_URL} from './urls'

interface StubNode {
  id: string
  title: string
  url?: string
  children?: StubNode[]
}

/**
 * 用内存书签树替换 `chrome.*`。
 *
 * `get` 与真实 API 一致：不回填 `children`——只有 `getTree` 与 `getSubTree` 才带子孙。
 * 这一点很关键，靠 `get` 判「文件夹还在不在」的代码不会因为打桩而变得比真机宽松。
 *
 * 但 `parentId` 必须给：`getNodePath` 就是靠它在树里向上走的。
 */
function stubChrome(tree: StubNode[]): void {
  const parents = new Map<string, string>()

  // 先走一遍把父子关系记全（根节点没有 parentId，与真实 API 一致）。
  const recordParents = (nodes: StubNode[], parentId?: string): void => {
    for (const node of nodes) {
      if (parentId !== undefined) parents.set(node.id, parentId)
      recordParents(node.children ?? [], node.id)
    }
  }
  recordParents(tree)

  const find = (nodes: StubNode[], id: string): StubNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node
      const hit = find(node.children ?? [], id)
      if (hit) return hit
    }
    return undefined
  }

  const shallow = (node: StubNode): Record<string, unknown> => ({
    id: node.id,
    title: node.title,
    url: node.url,
    parentId: parents.get(node.id)
  })
  const deep = (node: StubNode): Record<string, unknown> => ({
    ...shallow(node),
    children: (node.children ?? []).map(deep)
  })

  ;(globalThis as Record<string, unknown>).chrome = {
    bookmarks: {
      getTree: async () => tree.map(deep),
      getSubTree: async (id: string) => {
        const node = find(tree, id)
        if (!node) throw new Error(`未知节点 ${id}`)
        return [deep(node)]
      },
      get: async (id: string) => {
        const node = find(tree, id)
        if (!node) throw new Error(`未知节点 ${id}`)
        return [shallow(node)]
      }
    }
  }
}

const TREE: StubNode[] = [
  {
    id: '0',
    title: '',
    children: [
      // 故意把「其他书签」排在书签栏前面：书签栏必须按 id 认，不能按位置认。
      {id: '2', title: '其他书签'},
      {
        id: '1',
        title: '书签栏',
        children: [
          {id: '10', title: '书签A', url: 'https://a.example'},
          // 分隔线插在「书签A」与「存档」之间：它不进任何计数，但要保持在这个位置。
          {id: '15', title: '', url: SEPARATOR_URL},
          {
            id: '11',
            title: '存档',
            children: [
              {id: '12', title: '标签页存档', children: []},
              {id: '16', title: '── 工作 ──', url: SEPARATOR_URL},
              {id: '13', title: '书签B', url: 'https://b.example'}
            ]
          },
          {id: '14', title: '空的', children: []}
        ]
      }
    ]
  }
]

test('getBookmarksBarId 按 id 认书签栏，而不是按位置', async () => {
  stubChrome(TREE)
  assert.equal(await getBookmarksBarId(), '1')
})

test('getNodePath 由浅到深给出祖先，含自身与 id', async () => {
  stubChrome(TREE)

  // 13 是「书签栏 / 存档 / 书签B」这枚书签，用来验证路径是逐层向上的。
  assert.deepEqual(await getNodePath('13'), [
    {id: '0', title: '书签'},
    {id: '1', title: '书签栏'},
    {id: '11', title: '存档'},
    {id: '13', title: '书签B'}
  ])
})

test('getNodePath 的根节点用「书签」兜底，不留空白格', async () => {
  stubChrome(TREE)

  const path = await getNodePath('1')
  // 真实书签树里根的 title 是空串。
  assert.equal(path[0].title, '书签')
  assert.equal(path[0].id, '0')
})

test('getNodePath 取的是 id 而不只是标题，面包屑才能做成链接', async () => {
  stubChrome(TREE)

  const path = await getNodePath('12')
  assert.deepEqual(
    path.map((node) => node.id),
    ['0', '1', '11', '12']
  )
})

test('getNodePath 遇到不存在的节点返回空数组，不抛错', async () => {
  stubChrome(TREE)
  assert.deepEqual(await getNodePath('nope'), [])
})

test('getBookmarksBarId 认不出书签栏时报错，绝不退化为「其他书签」', async () => {
  stubChrome([{id: '0', title: '', children: [{id: '2', title: '其他书签'}]}])
  await assert.rejects(getBookmarksBarId(), /找不到书签栏/)
})

test('listArchiveRootCandidates 第一项是书签栏自身，书签与「其他书签」都不进列表', async () => {
  stubChrome(TREE)
  const {barTitle, folders} = await listArchiveRootCandidates()

  assert.equal(barTitle, '书签栏')
  assert.deepEqual(
    folders.map((folder) => folder.id),
    ['1', '11', '12', '14']
  )
})

test('listArchiveRootCandidates 的 path 不含书签栏，层级用 path 表达', async () => {
  stubChrome(TREE)
  const {folders} = await listArchiveRootCandidates()

  assert.deepEqual(
    folders.map((folder) => folder.path),
    [[], [], ['存档'], []]
  )
})

test('listArchiveRootCandidates 的计数只算直属书签，总数递归到后代', async () => {
  stubChrome(TREE)
  const {folders} = await listArchiveRootCandidates()
  const [bar, archive] = folders

  assert.equal(bar.bookmarkCount, 1, '书签栏直属只有「书签A」')
  assert.equal(bar.folderCount, 2, '存档、空的')
  assert.equal(bar.totalBookmarkCount, 2, '书签A + 子文件夹里的书签B')

  assert.equal(archive.bookmarkCount, 1, '存档直属只有「书签B」')
  assert.equal(archive.folderCount, 1, '标签页存档')
  assert.equal(archive.totalBookmarkCount, 1)
})

test('分隔线不算书签：计数里看不到它，但它照旧留在书签树里', async () => {
  stubChrome(TREE)
  const {folders} = await listArchiveRootCandidates()
  const [bar, archive] = folders

  // 两个文件夹里各插了一枚分隔线（id 15 / 16），上面的数字与没插时一模一样——
  // 这正是回归点：若哪天又用「有没有 url」当「是不是书签」，这四个数字就会各多 1。
  assert.equal(bar.bookmarkCount, 1)
  assert.equal(bar.totalBookmarkCount, 2)
  assert.equal(archive.bookmarkCount, 1)
  assert.equal(archive.totalBookmarkCount, 1)
})

test('isRealBookmark 把分隔线与真书签分开，folder 两种都不是', () => {
  assert.equal(isRealBookmark({id: 'x', title: '书签', url: 'https://a.example'}), true)
  assert.equal(isRealBookmark({id: 'x', title: '', url: SEPARATOR_URL}), false)
  assert.equal(isRealBookmark({id: 'x', title: '── 工作 ──', url: SEPARATOR_URL}), false)
  assert.equal(isRealBookmark({id: 'x', title: '文件夹', children: []}), false)
  assert.equal(isRealBookmark({id: 'x', title: ''}), false)
})

test('realBookmarks 只留真书签，且保持原顺序', () => {
  assert.deepEqual(
    realBookmarks([
      {id: 'a', title: 'A', url: 'https://a.example'},
      {id: 's1', title: '', url: SEPARATOR_URL},
      {id: 'f', title: '文件夹', children: []},
      {id: 's2', title: '── B ──', url: SEPARATOR_URL},
      {id: 'b', title: 'B', url: 'https://b.example'}
    ]).map((node) => node.id),
    ['a', 'b']
  )
  assert.deepEqual(realBookmarks([]), [])
})

test('listFolders 默认不含根自身（主界面按存档列出会话）', async () => {
  stubChrome(TREE)
  assert.deepEqual(
    (await listFolders('1')).map((folder) => folder.id),
    ['11', '12', '14']
  )
})

test('listFolders 遇到不存在的 id 返回空数组，而不是抛错', async () => {
  stubChrome(TREE)
  assert.deepEqual(await listFolders('nope'), [])
})
