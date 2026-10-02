import {tileHue, tileInitial} from './urls'

/** 生成占位卡片：用主机名推导的色相 + 首字母，避免申请 favicon 权限、也不发任何网络请求。 */
export function tileMarkup(title: string, url: string): string {
  const initial = escapeHtml(tileInitial(title, url))
  const hue = tileHue(url)
  return (
    `<span class="tile" style="--tile-hue:${hue}" aria-hidden="true">` +
    `<span class="tile__text">${initial}</span>` +
    '</span>'
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
