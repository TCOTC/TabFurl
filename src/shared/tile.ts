import {faviconUrl} from './urls'

/**
 * 生成网站图标。
 *
 * 只出一张真图标，没有底色与首字母：图标本身已经能区分站点。
 *
 * **不需要失败处理**。2026-10-02 在真实 Chrome 里实测：`_favicon` 从不失败——缓存里有就返回真图标，
 * 没有就返回**默认地球**，连根本不存在的域名也返回 32×32 的图片（`onerror` 不触发）。
 * 所以它要么是真图标、要么是地球，不会出破图。`alt=""` 仍保留：它是装饰性图片，
 * 不该被读屏念出来。
 *
 * @param faviconBase `chrome.runtime.getURL('_favicon/')`；不传时返回空串（降级用）。
 */
export function faviconMarkup(url: string, faviconBase?: string): string {
  if (!faviconBase) return ''
  return (
    `<img class="favicon" src="${escapeHtml(faviconUrl(url, faviconBase))}"` +
    ' alt="" loading="lazy" />'
  )
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
