import {faviconUrl, tileHue, tileInitial} from './urls'

/**
 * 生成卡片：真实的网站图标 + 底层的首字母色块。
 *
 * 首字母色块永远是底层，图标盖在它上面。图标加载不出来时会被移掉（见 `decorateTiles`），
 * 于是自然露出字母——所以「Chrome 缓存未命中时返回什么」不影响观感，两种情况下都不会出现破图。
 *
 * @param faviconBase `chrome.runtime.getURL('_favicon/')`；不传则只出首字母色块。
 */
export function tileMarkup(title: string, url: string, faviconBase?: string): string {
  const initial = escapeHtml(tileInitial(title, url))
  const hue = tileHue(url)
  const icon = faviconBase
    ? `<img class="tile__icon" src="${escapeHtml(
        faviconUrl(url, faviconBase)
      )}" alt="" loading="lazy" />`
    : ''
  return (
    `<span class="tile" style="--tile-hue:${hue}" aria-hidden="true">` +
    `<span class="tile__text">${initial}</span>${icon}` +
    '</span>'
  )
}

/**
 * 给渲染好的图标挂上「加载失败就藏起来」的监听。
 *
 * 不能用 `onerror="…"` 内联属性：MV3 扩展页面的默认 CSP 是 `script-src 'self'`，
 * 内联事件处理器会被拦下来，所以只能在渲染后补一次。
 *
 * 图标可能在挂监听之前就已经失败了（`complete` 且宽为 0），所以这一步也要查。
 */
export function decorateTiles(root: ParentNode): void {
  for (const icon of root.querySelectorAll<HTMLImageElement>('img.tile__icon')) {
    const drop = (): void => icon.remove()
    if (icon.complete && icon.naturalWidth === 0) drop()
    else icon.addEventListener('error', drop, {once: true})
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
