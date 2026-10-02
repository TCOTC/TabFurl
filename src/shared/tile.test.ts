import {test} from 'node:test'
import assert from 'node:assert/strict'
import {escapeHtml, tileMarkup} from './tile'

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

test('tileMarkup 输出固定的结构与数字色相', () => {
  const markup = tileMarkup('工作台', 'https://example.com')
  assert.match(markup, /^<span class="tile" style="--tile-hue:\d+" aria-hidden="true">/)
  assert.match(markup, /<span class="tile__text">工<\/span>/)
  assert.match(markup, /<\/span><\/span>$/)
})

test('不传 favicon 基址时不出图标，只有首字母色块', () => {
  const markup = tileMarkup('工作台', 'https://example.com')

  assert.ok(!markup.includes('<img'), '没有基址就拼不出端点，不要出破图')
  assert.ok(!markup.includes('_favicon'), '不得凭空拼一个相对地址')
})

test('传了 favicon 基址时，图标盖在首字母后面', () => {
  const markup = tileMarkup('工作台', 'https://example.com', 'chrome-extension://abc/_favicon/')

  // 字母必须在前面：图标是覆盖层，加载不出来时被移掉就露出字母。
  const textAt = markup.indexOf('tile__text')
  const iconAt = markup.indexOf('tile__icon')
  assert.ok(textAt >= 0 && iconAt >= 0, '两者都应在输出里')
  assert.ok(textAt < iconAt, '首字母必须在图标之前（作为底层）')
  assert.match(markup, /<img class="tile__icon" src="chrome-extension:\/\/abc\/_favicon\/\?pageUrl=[^"]+" alt="" loading="lazy" \/>/)
})

test('tileMarkup 不产生可逃逸的未转义尖括号', () => {
  const markup = tileMarkup(
    '<img src=x onerror=alert(1)>',
    'https://example.com',
    'chrome-extension://abc/_favicon/'
  )
  assert.ok(!markup.includes('<img src=x'), '标题内容不得原样进入 HTML')
  assert.ok(!markup.includes('onerror=alert'), '标题内容不得进入属性位置')
})
