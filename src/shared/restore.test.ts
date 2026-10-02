import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  applyExclusions,
  discardCommittedTabs,
  planRestore,
  restorableBookmarks,
  restoreFolder,
  type RestorePlan
} from './restore'
import type {BookmarkNode} from './types'

const folder = (id: string, title: string, children: BookmarkNode[] = []): BookmarkNode => ({
  id,
  title,
  children
})

const link = (id: string, url: string): BookmarkNode => ({id, title: url, url})

/** 分隔线占位书签（Maya Studios 约定）。它是个记号，不是要打开的页面。 */
const SEPARATOR = 'https://separator.mayastudios.com/index.php'
const divider = (id: string, title = ''): BookmarkNode => ({id, title, url: SEPARATOR})

/**
 * 一次「有分组」的保存结果。会话文件夹的子级按窗口顺序穿插：
 * 分组是子文件夹，未分组的标签是散装书签。
 */
const session = (): BookmarkNode =>
  folder('s', '2026-10-02 14:30', [
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
  const flat = folder('s', '2026-10-02 14:30', [
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

test('分隔线照常留在计划里（界面要按原位画出来），不计入 skipped', () => {
  const node = folder('s', '会话', [
    link('b1', 'https://a.com'),
    divider('sep1', '以下为工作'),
    link('b2', 'https://b.com')
  ])

  const plan = planRestore(node)

  assert.deepEqual(shape(plan), [
    {title: '', urls: ['https://a.com', SEPARATOR, 'https://b.com']}
  ])
  assert.equal(plan.skipped, 0, '分隔线不是「丢了东西」，不该计入 skipped')
  assert.deepEqual(
    plan.items[0].bookmarks.map((bookmark) => bookmark.separator),
    [false, true, false],
    '只有分隔线那一条带 separator 标记'
  )
})

test('restorableBookmarks 把分隔线从「会被打开的标签」里剔除', () => {
  const plan = planRestore(
    folder('s', '会话', [link('b1', 'https://a.com'), divider('sep1'), link('b2', 'https://b.com')])
  )

  assert.deepEqual(
    restorableBookmarks(plan.items.flatMap((item) => item.bookmarks)).map((b) => b.url),
    ['https://a.com', 'https://b.com']
  )
})

test('与内部页面不同，分隔线不算 skipped', () => {
  const {skipped} = planRestore(
    folder('s', '会话', [divider('sep1'), link('b1', 'chrome://newtab')])
  )

  assert.equal(skipped, 1, '只有内部页面记一笔')
})

test('只有分隔线的子文件夹不产生项', () => {
  const node = folder('s', '会话', [folder('g1', '全是线', [divider('sep1')])])

  assert.deepEqual(planRestore(node).items, [], '有标题但无标签的框只是噪声')
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

/**
 * 用内存书签树 + 记录调用的 chrome 桩跑 `restoreFolder`。
 *
 * 关注的是「打开后有没有把标签舍弃掉」这件事，所以只实现这条路径需要的几个方法。
 */
type TabState = {url?: string; pendingUrl?: string}

/**
 * 内存书签树 + 记录调用的 chrome 桩。
 *
 * `commitAfterPolls` 模拟真实 Chrome 的提交时机：`tabs.create()` 返回时导航还没提交
 * （`url` 为空、地址只在 `pendingUrl` 里），要等第 N 次 `tabs.get` 才看得到 `url`。
 * `neverCommit` 里的标签则永远停在未提交状态。
 */
function stubChrome(
  folderNode: BookmarkNode,
  options: {
    commitAfterPolls?: number
    neverCommit?: readonly number[]
    /** 预先存在的标签（不走 create），供直连 discardCommittedTabs 的测试使用。 */
    existing?: readonly {id: number; url: string}[]
  } = {}
): {
  discarded: number[]
  created: {url: string; active: boolean}[]
  grouped: number[][]
  gets: number
} {
  const committedAfter = options.commitAfterPolls ?? 1
  const neverCommit = new Set(options.neverCommit ?? [])
  const urls = new Map<number, string>((options.existing ?? []).map((t) => [t.id, t.url]))
  const discarded: number[] = []
  const created: {url: string; active: boolean}[] = []
  const grouped: number[][] = []
  let seq = 0
  let gets = 0

  const record = (tabId: number, url: string): void => {
    urls.set(tabId, url)
  }

  ;(globalThis as Record<string, unknown>).chrome = {
    bookmarks: {
      getSubTree: async (id: string) => {
        if (id !== folderNode.id) throw new Error(`未知节点 ${id}`)
        return [folderNode]
      }
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      getCurrent: async () => ({id: 7}),
      create: async (input: {url: string}) => {
        seq += 1
        created.push({url: input.url, active: true})
        record(seq, input.url)
        return {id: 1, tabs: [{id: seq}]}
      }
    },
    tabs: {
      create: async (input: {url: string; active: boolean}) => {
        seq += 1
        created.push({url: input.url, active: input.active})
        record(seq, input.url)
        return {id: seq, windowId: 7}
      },
      get: async (id: number): Promise<TabState & {id: number; windowId: number}> => {
        gets += 1
        const url = urls.get(id)
        if (!url) return {id, windowId: 7}

        const committed = !neverCommit.has(id) && gets >= committedAfter
        // 未提交时地址只在 pendingUrl 里，url 是空串——与真实 Chrome 一致。
        return committed
          ? {id, windowId: 7, url}
          : {id, windowId: 7, url: '', pendingUrl: url}
      },
      group: async (input: {tabIds: number[]}) => {
        grouped.push([...input.tabIds])
        return 100
      },
      discard: async (tabId: number) => {
        discarded.push(tabId)
        return {id: tabId, discarded: true}
      }
    },
    tabGroups: {update: async () => ({})}
  }

  return {discarded, created, grouped, get gets() { return gets }}
}

const threeTabs = (): BookmarkNode =>
  folder('s', '会话', [
    folder('g1', '工作', [link('b1', 'https://a.com'), link('b2', 'https://b.com')]),
    link('b3', 'https://loose.com')
  ])

/** 直接测 discardCommittedTabs 时用的预置标签（不走 create，所以得自己登记地址）。 */
const existingTabs = [
  {id: 1, url: 'https://a.com'},
  {id: 2, url: 'https://b.com'},
  {id: 3, url: 'https://loose.com'}
]

test('新窗口还原：活动标签保持加载，其余全部舍弃', async () => {
  const spy = stubChrome(threeTabs())

  const result = await restoreFolder('s', {target: 'newWindow'})

  assert.equal(result.opened, 3)
  assert.equal(result.discarded, 2, '三枚里应当舍弃两枚')
  assert.deepEqual(spy.discarded, [2, 3], '第一枚是活动标签，不能碰')
  assert.ok(!spy.discarded.includes(1), '活动标签不得出现在舍弃列表里')
})

test('当前窗口还原同样只留活动的那一枚', async () => {
  const spy = stubChrome(threeTabs())

  const result = await restoreFolder('s', {target: 'currentWindow'})

  assert.equal(result.discarded, 2)
  assert.ok(!spy.discarded.includes(1))

  // 当前窗口模式下只有第一个标签是 active，其余不能抢焦点。
  assert.deepEqual(
    spy.created.map((tab) => tab.active),
    [true, false, false]
  )
})

test('舍弃发生在建分组之后，且不影响分组内容', async () => {
  const spy = stubChrome(threeTabs())

  const result = await restoreFolder('s', {target: 'newWindow'})

  assert.equal(result.groups, 1)
  assert.deepEqual(spy.grouped, [[1, 2]], '分组里应当是本组的两枚标签')
  assert.deepEqual(spy.discarded, [2, 3], '组内的第二枚也要舍弃')
})

test('只有一个标签时无可舍弃，discarded 为 0', async () => {
  const spy = stubChrome(folder('s', '会话', [link('b1', 'https://only.com')]))

  const result = await restoreFolder('s', {target: 'newWindow'})

  assert.equal(result.opened, 1)
  assert.equal(result.discarded, 0)
  assert.deepEqual(spy.discarded, [], '唯一那枚就是活动标签')
})

test('舍弃失败不影响已打开的标签，也不算进 discarded', async () => {
  const spy = stubChrome(threeTabs())
  const chromeStub = (globalThis as Record<string, unknown>).chrome as {
    tabs: {discard: (tabId: number) => Promise<unknown>}
  }
  // 第二枚标签舍弃失败（比如它正在被用户拖拽）。
  chromeStub.tabs.discard = async (tabId: number) => {
    if (tabId === 2) throw new Error('user is dragging')
    spy.discarded.push(tabId)
    return {id: tabId}
  }

  const result = await restoreFolder('s', {target: 'newWindow'})

  assert.equal(result.opened, 3, '舍弃失败不该把已打开的标签算没')
  assert.equal(result.discarded, 1, '只有成功的那一枚算数')
})

test('还原时跳过散装的分隔线：不打开它的网址，也不影响其它标签', async () => {
  const spy = stubChrome(
    folder('s', '会话', [
      link('b1', 'https://a.com'),
      divider('sep1'),
      divider('sep2', '以下为工作'),
      link('b2', 'https://b.com')
    ])
  )

  const result = await restoreFolder('s', {target: 'newWindow'})

  assert.equal(result.opened, 2)
  assert.deepEqual(
    spy.created.map((tab) => tab.url),
    ['https://a.com', 'https://b.com'],
    '分隔线的网址一次都不该被打开'
  )
})

test('分组内的分隔线不占分组名额，也不会被打开', async () => {
  const spy = stubChrome(
    folder('s', '会话', [
      folder('g1', '工作', [divider('sep1', '标题'), link('b1', 'https://a.com')]),
      link('b2', 'https://b.com')
    ])
  )

  const result = await restoreFolder('s', {target: 'newWindow'})

  assert.equal(result.opened, 2)
  assert.equal(result.groups, 1)
  assert.deepEqual(spy.grouped, [[1]], '分组里只应有那一枚真标签')
})

test('整个存档只有分隔线时，还原不开任何标签也不报错', async () => {
  const spy = stubChrome(folder('s', '会话', [divider('sep1'), divider('sep2')]))

  const result = await restoreFolder('s', {target: 'newWindow'})

  assert.equal(result.opened, 0)
  assert.deepEqual(spy.created, [])
})

/**
 * 下面几条盯的是 2026-10-03 修掉的 bug：曾经在 `create()` 之后**立刻**舍弃，
 * 而那时导航还没提交、没有可恢复的地址，标签会变成 about:blank。
 */

test('导航已提交的标签才会被舍弃', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs})

  const discarded = await discardCommittedTabs([1, 2, 3], {
    keepLoadedTabId: 1,
    timing: {pollMs: 1, timeoutMs: 100}
  })

  assert.equal(discarded, 2)
  assert.deepEqual(spy.discarded, [2, 3])
})

test('未提交的标签一律不碰，等它提交后才舍弃', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs, commitAfterPolls: 3})

  const discarded = await discardCommittedTabs([2, 3], {
    timing: {pollMs: 1, timeoutMs: 200}
  })

  assert.equal(discarded, 2, '轮询到提交后就该动手')
  assert.deepEqual(spy.discarded, [2, 3])
  assert.ok(spy.gets >= 4, `应当轮询过多次，实际只查了 ${spy.gets} 次`)
})

test('超时仍没提交就放弃舍弃——宁可留着加载，也不能弄成空白页', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs, neverCommit: [2, 3]})

  const discarded = await discardCommittedTabs([2, 3], {
    timing: {pollMs: 1, timeoutMs: 20}
  })

  assert.equal(discarded, 0)
  assert.deepEqual(spy.discarded, [], '一次 discard 都不该发出去')
})

test('只舍弃已提交的那部分，未提交的留着', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs, neverCommit: [3]})

  const discarded = await discardCommittedTabs([2, 3], {
    timing: {pollMs: 1, timeoutMs: 20}
  })

  assert.equal(discarded, 1)
  assert.deepEqual(spy.discarded, [2], '只动已提交的那枚')
})

test('活动标签即使已提交也不舍弃', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs})

  const discarded = await discardCommittedTabs([1, 2], {
    keepLoadedTabId: 1,
    timing: {pollMs: 1, timeoutMs: 50}
  })

  assert.equal(discarded, 1)
  assert.ok(!spy.discarded.includes(1), '活动标签碰不得')
})

test('url 是空串、或只剩 pendingUrl 时都算未提交', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs, commitAfterPolls: 99})

  const discarded = await discardCommittedTabs([2], {timing: {pollMs: 1, timeoutMs: 15}})

  assert.equal(discarded, 0, '有 pendingUrl、url 为空时不得舍弃')
  assert.deepEqual(spy.discarded, [])
})

test('标签在轮询期间被关掉时跳过它，不抛错', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs})
  const chromeStub = (globalThis as Record<string, unknown>).chrome as {
    tabs: {get: (id: number) => Promise<unknown>}
  }
  chromeStub.tabs.get = async (id: number) => {
    if (id === 2) throw new Error('No tab with id: 2')
    return {id, windowId: 7, url: 'https://b.com'}
  }

  const discarded = await discardCommittedTabs([2, 3], {timing: {pollMs: 1, timeoutMs: 50}})

  assert.equal(discarded, 1, '只剩能查到的那些')
  assert.deepEqual(spy.discarded, [3])
})

test('空列表直接返回 0，不发任何调用', async () => {
  const spy = stubChrome(threeTabs(), {existing: existingTabs})

  assert.equal(await discardCommittedTabs([]), 0)
  assert.deepEqual(spy.discarded, [])
})
