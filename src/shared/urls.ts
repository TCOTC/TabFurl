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
