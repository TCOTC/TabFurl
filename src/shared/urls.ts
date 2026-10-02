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

/**
 * 书签分隔线的占位网址（Maya Studios 的约定）。
 *
 * Chrome 早已不支持书签分隔线，社区的做法是收藏一个**指向固定网址的书签**来模拟：
 * 它不指向任何有用内容，只是书签树里的一个组织记号，界面上画成一条横线。
 */
export const SEPARATOR_URL = 'https://separator.mayastudios.com/index.php'

const SEPARATOR = new URL(SEPARATOR_URL)
/** 省略路径时浏览器会补成 `/`，两种形态指的是同一枚分隔线。 */
const SEPARATOR_PATHS = new Set([SEPARATOR.pathname, '/'])

/**
 * 判定一枚书签是不是分隔线。
 *
 * 按**主机名 + 路径**比对，忽略协议、查询串与片段：同一个记号在不同工具、不同时期会写成
 * `http` / `https`，也可能带上 `?title=…` 之类的参数。路径只认 `/index.php` 与省略成 `/`
 * 两种形态——不能只认主机名，那会把该域名下的任意页面也当成记号吃掉。
 */
export function isSeparatorUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return (
      parsed.hostname.toLowerCase() === SEPARATOR.hostname &&
      SEPARATOR_PATHS.has(parsed.pathname.toLowerCase())
    )
  } catch {
    return false
  }
}

/** 分隔线标题两端的手画横杠（`─`）与空白，一起去掉。 */
const SEPARATOR_EDGES = /^[\s─]+|[\s─]+$/g

/**
 * 分隔线标题的清洗：去掉首尾的 `─`。
 *
 * 分隔线标题常被写成 `──── 工作 ────`——那两道横杠是**手画的线**。而界面已经用 CSS 画了线，
 * 留着它们就成了第二条线：长度写死、跟容器宽度对不上，看着像排版坏了。所以首尾的横杠一律剔除。
 *
 * 横杠与空白**当成同一类字符一起剥**，而不是只剥横杠再 `trim()`：写成 `─ ─ ─` 那种
 * 拿横杠和空格拼出来的假线，只剥一层会剩下中间那根，看着还是一条坏线。合成一个字符集就不会漏。
 * 好处是整条都是横杠、或横杠加空格时结果为空串，于是走「无标题」那条路，只画一条线——正是想要的。
 *
 * 只动首尾：`2020 ─ 2024` 中间那根是标题的一部分。
 */
export function separatorTitle(title: string): string {
  return title.replace(SEPARATOR_EDGES, '').trim()
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

/** 网站图标的像素尺寸。预留位是 22px，取 32 是为了在 @2x 屏上也清楚。 */
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
