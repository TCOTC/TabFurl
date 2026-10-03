import {faviconUrl} from './urls'

/**
 * 生成网站图标。只出一张真图标（没有底色与首字母）。
 *
 * **不需要失败处理**：2026-10-02 真实 Chrome 实测——`_favicon` 从不失败，缓存里有就返回真图标、
 * 没有就返回**默认地球**，连不存在的域名也返回 32×32 图片（`onerror` 不触发）。
 * `alt=""` 保留：它是装饰图，不该被读屏念出来。
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
