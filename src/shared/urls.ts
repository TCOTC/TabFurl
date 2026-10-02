/** 浏览器内部页面：既不能收藏，收藏了也打不开。 */
const INTERNAL_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
  'moz-extension://',
  'data:',
  'javascript:'
]

export function isInternalUrl(url: string | undefined): boolean {
  if (!url) return true
  return INTERNAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
}

/** 取主机名，去掉 `www.`。取不到时返回 undefined。 */
export function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host || undefined
  } catch {
    return undefined
  }
}

/** 书签卡片上的占位字母：优先标题首字，退化为主机名首字母。 */
export function tileInitial(title: string, url: string): string {
  const source = title.trim() || hostnameOf(url) || url
  const match = source.match(/[\p{L}\p{N}]/u)
  return (match?.[0] ?? '?').toUpperCase()
}

/** 由字符串稳定推导出的色相（0–359），用于占位卡片配色。 */
export function tileHue(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360
  }
  return hash
}

/** 网站图标的像素尺寸。色块是 22px，取 32 是为了在 @2x 屏上也清楚。 */
export const FAVICON_SIZE = 32

/**
 * 拼出 `_favicon` 端点的地址：`chrome-extension://<id>/_favicon/?pageUrl=…&size=32`。
 *
 * 它读的是 Chrome **本地**的 favicon 缓存，不发任何网络请求（需要 `favicon` 权限）；
 * 与 `tabs.Tab.favIconUrl` 不同——后者指向网站服务器，渲染时等于向该站点发请求。
 *
 * @param faviconBase `chrome.runtime.getURL('_favicon/')`。
 */
export function faviconUrl(pageUrl: string, faviconBase: string): string {
  const url = new URL(faviconBase)
  url.searchParams.set('pageUrl', pageUrl)
  url.searchParams.set('size', String(FAVICON_SIZE))
  return url.toString()
}
