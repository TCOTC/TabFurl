import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {WindowChild} from '../shared/capture'
import type {TabSnapshot} from '../shared/types'

globalThis.chrome = {
  runtime: {getURL: (path: string) => `chrome-extension://stub/${path}`}
} as unknown as typeof chrome

const {
  closeKey,
  closeSlotMarkup,
  countLabel,
  groupRowMarkup,
  parseCloseKey,
  pendingCloseKey,
  statusSlotMarkup,
  tabRowMarkup,
  windowSignatureOf
} = await import('./windowMarkup')

function tab(over: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    tabId: 1,
    title: 't1',
    url: 'https://a.test/',
    pinned: false,
    index: 0,
    status: 'complete',
    active: false,
    ...over
  }
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

test('countLabel：半角括号 + 一个空格（全角括号在中文字体里占满一格，看着发虚）', () => {
  assert.equal(countLabel('存过去', 3), '存过去 (3)')
  assert.equal(countLabel('打开', 0), '打开 (0)')
})

test('closeKey / parseCloseKey：往返一致，两类目标不混', () => {
  assert.equal(closeKey({kind: 'tab', tabId: 7}), 't7')
  assert.equal(closeKey({kind: 'group', groupId: 3}), 'g3')
  assert.deepEqual(parseCloseKey('t7'), {kind: 'tab', tabId: 7})
  assert.deepEqual(parseCloseKey('g3'), {kind: 'group', groupId: 3})
  assert.deepEqual(parseCloseKey(closeKey({kind: 'tab', tabId: 903})), {kind: 'tab', tabId: 903})
})

test('pendingCloseKey：没有等待中的目标时是 undefined，而不是空串', () => {
  assert.equal(pendingCloseKey(undefined), undefined)
  assert.equal(pendingCloseKey({kind: 'tab', tabId: 4}), 't4')
  assert.equal(pendingCloseKey({kind: 'group', groupId: 9}), 'g9')
})

test('closeSlotMarkup：没轮到它时给「关闭」，轮到它时给「确认关闭 + 取消」', () => {
  const idle = closeSlotMarkup('t7', '关闭这一枚', undefined)
  assert.match(idle, /data-close="t7"/)
  assert.equal(count(idle, 'data-confirm-close'), 0)

  const pending = closeSlotMarkup('t7', '关闭这一枚', 't7')
  assert.match(pending, /data-confirm-close="t7"/)
  assert.match(pending, /data-cancel-close/)
  assert.equal(count(pending, 'data-close="t7"'), 0)
})

test('closeSlotMarkup：分组的 g<groupId> 与标签的 t<tabId> 不会撞', () => {
  assert.match(closeSlotMarkup('g100', 'x', 'g100'), /data-confirm-close="g100"/)
  assert.match(closeSlotMarkup('g100', 'x', 't100'), /data-close="g100"/)
})

test('statusSlotMarkup：卸载 → 可点的「加载」', () => {
  const html = statusSlotMarkup(tab({status: 'unloaded'}))
  assert.match(html, /data-load-tab="1"/)
  assert.equal(count(html, 'disabled'), 0)
})

test('statusSlotMarkup：加载中 → 「加载中」且禁用（这一段可能很久，不能无声）', () => {
  const html = statusSlotMarkup(tab({status: 'loading'}))
  assert.match(html, /加载中/)
  assert.match(html, /disabled/)
  assert.equal(count(html, 'data-load-tab'), 0)
  assert.equal(count(html, 'data-release-tab'), 0)
})

test('statusSlotMarkup：加载完且非活动 → 「释放」', () => {
  const html = statusSlotMarkup(tab({status: 'complete', active: false}))
  assert.match(html, /data-release-tab="1"/)
})

test('statusSlotMarkup：**活动标签不给「释放」**（它就在屏幕上，卸载没意义）', () => {
  assert.equal(statusSlotMarkup(tab({status: 'complete', active: true})), '')
})

test('tabRowMarkup：带上拖拽落点需要的属性，以及勾选框与完整网址', () => {
  const html = tabRowMarkup(tab({tabId: 12, index: 3, groupId: 100, url: 'https://a.test/x'}), undefined)
  assert.match(html, /data-tab-index="3"/)
  assert.match(html, /data-tab-group="100"/)
  assert.match(html, /data-drag-tab="12"/)
  assert.match(html, /data-window-tab="12"/)
  assert.match(html, /data-row/)
  // 两处原样：`title` 属性与副文案。favicon 那一处是百分号编码的，不算。
  assert.equal(count(html, 'https://a.test/x'), 2)
  assert.match(html, /item__meta--url/)
})

test('tabRowMarkup：未分组时不写 data-tab-group（拖拽据此判「落点在组外」）', () => {
  assert.equal(count(tabRowMarkup(tab(), undefined), 'data-tab-group'), 0)
})

test('tabRowMarkup：固定的标签带图钉，标题为空时退回去显示网址', () => {
  assert.match(tabRowMarkup(tab({pinned: true}), undefined), /item__pin/)
  assert.equal(count(tabRowMarkup(tab(), undefined), 'item__pin'), 0)
  assert.match(tabRowMarkup(tab({title: ''}), undefined), /https:\/\/a\.test\//)
})

test('windowSignatureOf：结构没变 → 签名一样（同一份数据算两次）', () => {
  const children: WindowChild[] = [{kind: 'tab', tab: tab()}]
  assert.equal(windowSignatureOf(children), windowSignatureOf(children))
})

test('windowSignatureOf：**不能用自定分隔符**——拼接会撞车的组合必须区分开', () => {
  // 实测踩到过：用空格拼时 [a, b, a b] 与 [a b, a, b] 拼出同一个串。
  const one: WindowChild[] = [{kind: 'tab', tab: tab({title: 'a b'})}]
  const two: WindowChild[] = [
    {kind: 'tab', tab: tab({tabId: 1, title: 'a', url: 'https://x/'})},
    {kind: 'tab', tab: tab({tabId: 2, title: 'b', url: 'https://y/'})}
  ]
  assert.notEqual(windowSignatureOf(one), windowSignatureOf(two))
})

test('windowSignatureOf：行里画出来的东西都进签名（含写进 data 属性的 index / groupId）', () => {
  const base = [{kind: 'tab', tab: tab()}] as WindowChild[]
  const withStatus = [{kind: 'tab', tab: tab({status: 'unloaded'})}] as WindowChild[]
  const withActive = [{kind: 'tab', tab: tab({active: true})}] as WindowChild[]
  const withPinned = [{kind: 'tab', tab: tab({pinned: true})}] as WindowChild[]
  const withTitle = [{kind: 'tab', tab: tab({title: 'zzz'})}] as WindowChild[]
  const withUrl = [{kind: 'tab', tab: tab({url: 'https://zzz.test/'})}] as WindowChild[]
  // `index` / `groupId` 不在行里显示，但它们被写进 `data-tab-index` / `data-tab-group`：
  // 漏掉 → 标签被挪走/归组之后不重绘 → 行上留着过期的落点信息，下一次拖拽落到错的位置。
  const withIndex = [{kind: 'tab', tab: tab({index: 5})}] as WindowChild[]
  const withGroup = [{kind: 'tab', tab: tab({groupId: 100})}] as WindowChild[]
  const set = new Set(
    [base, withStatus, withActive, withPinned, withTitle, withUrl, withIndex, withGroup].map((c) =>
      windowSignatureOf(c)
    )
  )
  assert.equal(set.size, 8, '漏了某一项 → 那一行改了却不重绘')
})

test('windowSignatureOf：`lastAccessed` 不参与（它每点一次标签就变，进了签名就永远在变）', () => {
  const a = [{kind: 'tab', tab: tab({lastAccessed: 1})}] as WindowChild[]
  const b = [{kind: 'tab', tab: tab({lastAccessed: 999})}] as WindowChild[]
  assert.equal(windowSignatureOf(a), windowSignatureOf(b))
})

test('windowSignatureOf：分组名与组内标签都进签名', () => {
  const one = [{kind: 'group', name: '工作', tabs: [tab()]}] as WindowChild[]
  const renamed = [{kind: 'group', name: '别的', tabs: [tab()]}] as WindowChild[]
  const oneTab = [{kind: 'group', name: '工作', tabs: [tab()]}] as WindowChild[]
  const twoTabs = [{kind: 'group', name: '工作', tabs: [tab(), tab({tabId: 2})]}] as WindowChild[]
  assert.notEqual(windowSignatureOf(one), windowSignatureOf(renamed))
  assert.notEqual(windowSignatureOf(oneTab), windowSignatureOf(twoTabs))
})

test('windowSignatureOf：分组与散装标签不会撞车（结构本身被编码进 JSON）', () => {
  const group = [{kind: 'group', name: 'x', tabs: [tab({title: 'n'})]}] as WindowChild[]
  const loose = [
    {kind: 'tab', tab: tab({title: 'x'})},
    {kind: 'tab', tab: tab({tabId: 2, title: 'n'})}
  ] as WindowChild[]
  assert.notEqual(windowSignatureOf(group), windowSignatureOf(loose))
})

test('groupRowMarkup：拖拽下标用**分组在列表里的下标**，不是组内第一枚的 name', () => {
  const html = groupRowMarkup(
    {kind: 'group', name: '工作', tabs: [tab({groupId: 100}), tab({tabId: 2, groupId: 100})]},
    3,
    undefined
  )
  assert.match(html, /data-drag-group="3"/)
  assert.match(html, /data-group-id="100"/)
  assert.match(html, /2 个标签/)
  assert.equal(count(html, 'data-window-tab'), 2)
})

test('groupRowMarkup：确认态只落在命中的那一个上（标签的 t<id> 不会连带分组）', () => {
  const group = {kind: 'group', name: '工作', tabs: [tab({groupId: 100})]} as WindowChild & {
    kind: 'group'
  }
  const tabPending = groupRowMarkup(group, 0, 't1')
  assert.match(tabPending, /data-confirm-close="t1"/)
  // 分组那一枚没轮到：应该是普通的「关闭」。主键是 **groupId**，不是列表下标。
  assert.match(tabPending, /data-close="g100"/)
  assert.equal(count(tabPending, 'data-confirm-close="g100"'), 0)

  const groupPending = groupRowMarkup(group, 0, 'g100')
  assert.match(groupPending, /data-confirm-close="g100"/)
  assert.match(groupPending, /data-close="t1"/)
})

test('groupRowMarkup：拿不到 groupId 时**不给关闭按钮**（按名字/下标猜会关错组）', () => {
  const html = groupRowMarkup({kind: 'group', name: '工作', tabs: [tab()]}, 0, undefined)
  // 组内标签自己那一枚照常（它按 tabId 关，与 groupId 无关）。
  assert.match(html, /data-close="t1"/)
  assert.equal(count(html, 'data-close="g'), 0)
  assert.equal(count(html, 'data-confirm-close'), 0)
})
