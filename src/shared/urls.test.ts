import {test} from 'node:test'
import assert from 'node:assert/strict'
import {
  FAVICON_SIZE,
  SEPARATOR_URL,
  faviconUrl,
  hostnameOf,
  isInternalUrl,
  isSeparatorUrl
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
