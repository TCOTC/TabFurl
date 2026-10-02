import {test} from 'node:test'
import assert from 'node:assert/strict'
import {escapeHtml, faviconMarkup} from './tile'

test('escapeHtml 覆盖五个 HTML 敏感字符', () => {
  assert.equal(escapeHtml('&'), '&amp;')
  assert.equal(escapeHtml('<'), '&lt;')
  assert.equal(escapeHtml('>'), '&gt;')
  assert.equal(escapeHtml('"'), '&quot;')
  assert.equal(escapeHtml("'"), '&#39;')
})

test('escapeHtml 先处理 & ，不会产生二次转义漏洞', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;')
})

test('escapeHtml 不改动普通文本', () => {
  assert.equal(escapeHtml('工作 123'), '工作 123')
})

test('faviconMarkup 只出一张真图标，没有首字母与底色', () => {
  const markup = faviconMarkup('https://example.com', 'chrome-extension://abc/_favicon/')

  assert.match(
    markup,
    /^<img class="favicon" src="chrome-extension:\/\/abc\/_favicon\/\?pageUrl=[^"]+" alt="" loading="lazy" \/>$/
  )
  // 装饰性图片：alt 必须为空，读屏不该念出网址。
  assert.ok(markup.includes('alt=""'), 'alt 必须为空')
  assert.ok(!markup.includes('tile__text'), '不再有首字母')
  assert.ok(!/<span/.test(markup), '不再需要外层色块')
  assert.ok(!markup.includes('--tile-hue'), '不再有按 URL 推导的底色')
})

test('没有 favicon 基址时返回空串，不凭空拼相对地址', () => {
  assert.equal(faviconMarkup('https://example.com'), '')
  assert.equal(faviconMarkup('https://example.com', ''), '')
})

test('faviconMarkup 的网址会转义，不会逃出属性', () => {
  const markup = faviconMarkup('https://example.com/a"b', 'chrome-extension://abc/_favicon/')

  // 网址先经 URL 序列化（`"` 变成 `%22`），再由 escapeHtml 兜一层；两种情况都不该出现裸引号。
  assert.ok(!markup.includes('a"b'), '双引号不得原样进入属性')
  // class、src、alt、loading 各一对引号，多一个都说明有内容逃出了属性。
  assert.equal(markup.match(/"/g)?.length, 8, '引号数必须正好是属性的那 8 个')
})
