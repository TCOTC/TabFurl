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
 * 书签分隔记号的占位网址（Maya Studios 的约定）。Chrome 早已不支持书签分隔线，社区做法是收藏一个
 * **指向固定网址的书签**来模拟：它不指向有用内容，只是书签树里的组织记号。
 * 同一网址靠 `?t=` 分成两种形态，名字与外观都不同（见下面两个常量）。
 */
const SEPARATOR_HOST = 'separator.mayastudios.com'
const SEPARATOR_PATH = '/index.php'
/** 省略路径时浏览器会补成 `/`，两种形态指的是同一枚记号。 */
const SEPARATOR_PATHS = new Set([SEPARATOR_PATH, '/'])

/**
 * **间隔**：横向的一种，画成一条通栏横线。它本来是为**竖向排列**（书签菜单、收藏夹列表）准备的：
 * 竖排里要一条横线才隔得开。名字不叫「分隔线」而叫「间隔」是为了两个按钮叫得出区别。
 */
export const GAP_URL = 'https://separator.mayastudios.com/index.php?t=horz'

/**
 * **分隔线**：纵向的一种，画成一枚**竖线图标**。它是为**横向排列**（书签栏那一排）准备的：
 * 横排里要一条竖线才隔得开 → 不能画成横线（那与它的含义相反）。
 */
export const SEPARATOR_URL = 'https://separator.mayastudios.com/index.php'

/** `sep` 是纵向的分隔线（竖线图标），`gap` 是横向的间隔（一条横线）。 */
export type SeparatorKind = 'sep' | 'gap'

/** 两种记号的界面名。两个按钮、行内操作与状态文案都从这里取，不各自拼字。 */
export const SEPARATOR_LABELS: Record<SeparatorKind, string> = {
  sep: '分隔线',
  gap: '间隔'
}

/**
 * 记号的种类，不是记号时返回 undefined。
 * 判定按**主机名 + 路径**（只认 `/index.php` 与 `/`）——只认主机名会把该域名下任意页面也当成记号。
 * `?t=horz`（或 `horizontal`）是横向的间隔，其余（无参数 / `?t=vert` / 其他）一律当纵向的分隔线。
 */
export function separatorKind(url: string | undefined): SeparatorKind | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase() !== SEPARATOR_HOST) return undefined
    if (!SEPARATOR_PATHS.has(parsed.pathname.toLowerCase())) return undefined
    const type = (parsed.searchParams.get('t') ?? '').toLowerCase()
    return type === 'horz' || type === 'horizontal' ? 'gap' : 'sep'
  } catch {
    return undefined
  }
}

/** 一枚书签是不是记号（不管是分隔线还是间隔）。 */
export function isSeparatorUrl(url: string | undefined): boolean {
  return separatorKind(url) !== undefined
}

/** 某种记号对应的占位网址：转换类型时用它改写书签的 `url`。 */
export function separatorUrlOf(kind: SeparatorKind): string {
  return kind === 'gap' ? GAP_URL : SEPARATOR_URL
}

/** 反过来的一种：行内的转换按钮拿它当目标。 */
export function toggledSeparatorKind(kind: SeparatorKind): SeparatorKind {
  return kind === 'gap' ? 'sep' : 'gap'
}

/**
 * 浏览器自带书签管理器里某个文件夹的地址。`?id=` 收的是 `chrome.bookmarks` 的**数字 id**
 *（管理器地址栏显 UUID，但 `router.ts` 的 `findIdByLegacyId()` 会把数字 id 映射过去并改写地址栏）。
 * **Chrome 154.x 上这个入口是坏的**（Mojo 迁移回归，issue 565829425；修在 155.0.8059.26）
 * → 旧版上会看到「打开了但没落在那一层」，不是我们的 bug。所以不要改回 `?q=<层名>` 搜索。
 */
export function bookmarkManagerUrl(folderId: string): string {
  return `chrome://bookmarks/?id=${encodeURIComponent(folderId)}`
}

/** 分隔线标题两端的手画横杠（`─`）与空白，一起去掉。 */
const SEPARATOR_EDGES = /^[\s─]+|[\s─]+$/g

/**
 * 分隔线标题的清洗：去掉首尾的 `─` 与空白。那些横杠是**手画的线**，而界面已经用 CSS 画了线，
 * 留着它们就成了第二条线（长度写死、跟容器宽度对不上）。
 *
 * 横杠与空白**当同一类字符一起剥**（而不是只剥横杠再 `trim()`）：写成 `─ ─ ─` 那种拿横杠和空格
 * 拼的假线，只剥一层会剩下中间那根。整条都是横杠时结果为空串 → 走「无标题」那条路，只画一条线。
 * **只动首尾**：`2020 ─ 2024` 中间那根是标题的一部分。
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
 * 拼出 `_favicon` 端点的地址。它读 Chrome **本地**缓存、不发网络请求（需 `favicon` 权限）；
 * 与 `tabs.Tab.favIconUrl` 不同——后者指向网站服务器，渲染时等于向该站发请求。
 */
export function faviconUrl(pageUrl: string, faviconBase: string): string {
  const url = new URL(faviconBase)
  url.searchParams.set('pageUrl', pageUrl)
  url.searchParams.set('size', String(FAVICON_SIZE))
  return url.toString()
}
