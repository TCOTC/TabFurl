import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getBookmarksBarId, listArchiveRootCandidates, listFolders} from './bookmarks'

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
 */
function stubChrome(tree: StubNode[]): void {
  const find = (nodes: StubNode[], id: string): StubNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node
      const hit = find(node.children ?? [], id)
      if (hit) return hit
    }
    return undefined
  }

  const shallow = (node: StubNode) => ({id: node.id, title: node.title, url: node.url})
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
          {
            id: '11',
            title: '存档',
            children: [
              {id: '12', title: '标签页存档', children: []},
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
