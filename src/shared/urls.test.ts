import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  FAVICON_SIZE,
  GAP_URL,
  SEPARATOR_LABELS,
  SEPARATOR_URL,
  bookmarkManagerUrl,
  extensionsPageUrl,
  faviconUrl,
  hostnameOf,
  isInternalUrl,
  isSeparatorUrl,
  separatorKind,
  separatorTitle,
  separatorUrlOf,
  toggledSeparatorKind
} from './urls'

test('isInternalUrl 把空值与内部页面判为不可收藏', () => {
  assert.equal(isInternalUrl(undefined), true)
  assert.equal(isInternalUrl(''), true)

  for (const url of [
    'chrome://settings',
    'chrome-extension://abcdef/page.html',
    'chrome-untrusted://foo',
    'devtools://devtools/bundled/inspector.html',
    'edge://settings',
    'about:blank',
    'view-source:https://example.com',
    'moz-extension://foo/bar.html',
    'data:text/html,<b>x</b>',
    'javascript:void(0)'
  ]) {
    assert.equal(isInternalUrl(url), true, `${url} 应被判为内部页面`)
  }
})

test('isInternalUrl 放行普通网页地址', () => {
  for (const url of ['https://example.com', 'http://a.b/c', 'file:///c:/x.html']) {
    assert.equal(isInternalUrl(url), false, `${url} 应被放行`)
  }
})

test('isInternalUrl 前缀匹配区分大小写（与 chrome 的 url 形态一致）', () => {
  assert.equal(isInternalUrl('CHROME://settings'), false)
})

test('isSeparatorUrl 认出分隔线占位书签（忽略协议、查询串与片段）', () => {
  assert.equal(isSeparatorUrl(SEPARATOR_URL), true)

  for (const url of [
    'http://separator.mayastudios.com/index.php',
    'https://separator.mayastudios.com/index.php?title=x',
    'https://separator.mayastudios.com/index.php#top',
    'https://SEPARATOR.mayastudios.com/index.php',
    // 省略路径时浏览器会补成 `/`，指的是同一枚记号。
    'https://separator.mayastudios.com/',
    'https://separator.mayastudios.com'
  ]) {
    assert.equal(isSeparatorUrl(url), true, `${url} 应被判为分隔线`)
  }
})

test('isSeparatorUrl 不误伤同名域名下的其他页面与普通书签', () => {
  for (const url of [
    'https://separator.mayastudios.com/other.php',
    'https://separator.mayastudios.com/index.php/extra',
    'https://example.com',
    // 后缀伪装的域名不能算。
    'https://separator.mayastudios.com.evil.test/index.php'
  ]) {
    assert.equal(isSeparatorUrl(url), false, `${url} 不该被判为分隔线`)
  }

  assert.equal(isSeparatorUrl(undefined), false)
  assert.equal(isSeparatorUrl(''), false)
  assert.equal(isSeparatorUrl('not a url'), false)
})

test('separatorKind 把两种记号分开：`?t=horz` 是间隔，其余是分隔线', () => {
  assert.equal(separatorKind(GAP_URL), 'gap')
  assert.equal(separatorKind(SEPARATOR_URL), 'sep')

  // 写全的 `?t=horizontal` 与省略协议、路径的写法都算同一枚记号。
  assert.equal(separatorKind('https://separator.mayastudios.com/index.php?t=horizontal'), 'gap')
  assert.equal(separatorKind('http://separator.mayastudios.com/?t=horz'), 'gap')
  assert.equal(separatorKind('https://separator.mayastudios.com/index.php?t=vert'), 'sep')
  assert.equal(separatorKind('https://separator.mayastudios.com/index.php?title=x'), 'sep')
  assert.equal(separatorKind('https://separator.mayastudios.com'), 'sep')

  // 大小写不敏感：不同工具写出来的参数不保证一致。
  assert.equal(separatorKind('https://separator.mayastudios.com/index.php?t=HORZ'), 'gap')

  assert.equal(separatorKind('https://example.com'), undefined)
  assert.equal(separatorKind(undefined), undefined)
})

test('separatorUrlOf 与 toggledSeparatorKind 互为可往返的一对', () => {
  // 转换按钮的实现就是这两句：读出现在是哪种、写回另一种的网址。
  // 它们必须一致，否则「转过去再转回来」会落到第三种网址上（那就不再是记号了）。
  for (const kind of ['sep', 'gap'] as const) {
    const other = toggledSeparatorKind(kind)
    assert.notEqual(other, kind)
    assert.equal(separatorKind(separatorUrlOf(other)), other, '转过去的网址必须认成另一种')
    assert.equal(separatorKind(separatorUrlOf(toggledSeparatorKind(other))), kind, '往返要回到自身')
  }

  assert.equal(separatorUrlOf('gap'), GAP_URL)
  assert.equal(separatorUrlOf('sep'), SEPARATOR_URL)
})

test('两种记号各有自己的名字（按钮与状态文案都从这里取）', () => {
  assert.equal(SEPARATOR_LABELS.sep, '分隔线')
  assert.equal(SEPARATOR_LABELS.gap, '间隔')
})

test('bookmarkManagerUrl 用数字 id 直接定位到那一层', () => {
  // 数字 id 是官方入口（浏览器自己的右键菜单就这么生成 URL），只是 154.x 有个回归。
  assert.equal(bookmarkManagerUrl('80'), 'chrome://bookmarks/?id=80')
  assert.equal(bookmarkManagerUrl('380'), 'chrome://bookmarks/?id=380')
})

test('extensionsPageUrl 用运行时给的 id 指向本扩展自己', () => {
  // id 是运行时值（`chrome.runtime.id`），这里只验拼法：写死一个 id 在别人机器上指的是另一个扩展。
  assert.equal(
    extensionsPageUrl('djjjlbfhdnonfphnjdeoeoofdpdglofd'),
    'chrome://extensions/?id=djjjlbfhdnonfphnjdeoeoofdpdglofd'
  )
  assert.equal(extensionsPageUrl('a b'), 'chrome://extensions/?id=a%20b')
})

test('separatorTitle 剔除首尾手画的横杠，并收掉留下的空白', () => {
  assert.equal(separatorTitle('──── 工作 ────'), '工作')
  assert.equal(separatorTitle('─阅读─'), '阅读')
  assert.equal(separatorTitle('─ 阅读'), '阅读')
  assert.equal(separatorTitle('阅读 ─'), '阅读')
  assert.equal(separatorTitle('  阅读  '), '阅读')
  assert.equal(separatorTitle('阅读'), '阅读')
})

test('separatorTitle 只动首尾，中间的横杠是标题的一部分', () => {
  assert.equal(separatorTitle('2020 ─ 2024'), '2020 ─ 2024')
  assert.equal(separatorTitle('─── A ─ B ───'), 'A ─ B')
})

test('整条都是横杠时标题为空，分隔线退化成只画一条线', () => {
  assert.equal(separatorTitle('───────'), '')
  assert.equal(separatorTitle('─ ─ ─'), '', '剥完只剩空白，也算无标题')
  assert.equal(separatorTitle(''), '')
})

test('hostnameOf 去掉 www 前缀', () => {
  assert.equal(hostnameOf('https://www.example.com/a/b'), 'example.com')
  assert.equal(hostnameOf('https://sub.example.com'), 'sub.example.com')
  assert.equal(hostnameOf('https://example.com:8443/x'), 'example.com')
})

test('hostnameOf 取不到时返回 undefined', () => {
  assert.equal(hostnameOf(undefined), undefined)
  assert.equal(hostnameOf(''), undefined)
  assert.equal(hostnameOf('not a url'), undefined)
})

test('faviconUrl 拼在 _favicon 端点上并带上 size', () => {
  const url = new URL(faviconUrl('https://example.com/page', 'chrome-extension://abc/_favicon/'))

  assert.equal(url.pathname, '/_favicon/')
  assert.equal(url.searchParams.get('pageUrl'), 'https://example.com/page')
  assert.equal(url.searchParams.get('size'), String(FAVICON_SIZE))
})

test('faviconUrl 会转义 pageUrl 里的保留字符', () => {
  const pageUrl = 'https://example.com/a b?q=1&r=2#frag'
  const result = faviconUrl(pageUrl, 'chrome-extension://abc/_favicon/')

  // 参数字面量本身不能带着 & 与空白跑出来，否则会被拆成两个参数。
  assert.ok(!result.includes(' '), '空白必须被转义')
  assert.ok(!result.includes('?q=1&r=2'), 'pageUrl 里的 & 必须被转义')
  assert.equal(
    new URL(result).searchParams.get('pageUrl'),
    pageUrl,
    '取回来必须与传进去的完全相同（含 fragment）'
  )
})
