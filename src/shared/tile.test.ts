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

test('tileMarkup 不产生可逃逸的未转义尖括号', () => {
  const markup = tileMarkup('<img src=x onerror=alert(1)>', 'https://example.com')
  assert.ok(!markup.includes('<img'), '标题内容不得原样进入 HTML')
  assert.ok(!markup.includes('onerror='), '标题内容不得进入属性位置')
})
