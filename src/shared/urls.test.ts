import {test} from 'node:test'
import assert from 'node:assert/strict'
import {hostnameOf, isInternalUrl, tileHue, tileInitial} from './urls'

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

test('tileInitial 优先标题，其次主机名，最后兜底问号', () => {
  assert.equal(tileInitial('工作台', 'https://a.com'), '工')
  assert.equal(tileInitial('github', 'https://a.com'), 'G')
  // 标点被跳过，取第一个字母或数字。
  assert.equal(tileInitial('[重要] 通知', 'https://a.com'), '重')
  assert.equal(tileInitial('123', 'https://a.com'), '1')
  // 标题为空时退化为主机名首字母。
  assert.equal(tileInitial('', 'https://example.com'), 'E')
  // 什么都没有时给出确定的占位符，不留空。
  assert.equal(tileInitial('', ''), '?')
})

test('tileHue 稳定且落在 0–359', () => {
  for (const seed of ['', 'https://a.com', 'https://example.com/x', '例子']) {
    const hue = tileHue(seed)
    assert.equal(hue, tileHue(seed), '同一输入必须得到同一色相')
    assert.ok(Number.isInteger(hue), '色相应为整数')
    assert.ok(hue >= 0 && hue <= 359, `色相越界：${hue}`)
  }
  assert.equal(tileHue(''), 0)
})
