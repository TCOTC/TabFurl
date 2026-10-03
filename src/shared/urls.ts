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
 * 书签分隔记号的占位网址（Maya Studios 的约定）。
 *
 * Chrome 早已不支持书签分隔线，社区的做法是收藏一个**指向固定网址的书签**来模拟：
 * 它不指向任何有用内容，只是书签树里的一个组织记号。
 * 同一个网址靠 `?t=` 参数分成两种形态，名字与外观都不同（见下面两个常量）。
 */
const SEPARATOR_HOST = 'separator.mayastudios.com'
const SEPARATOR_PATH = '/index.php'
/** 省略路径时浏览器会补成 `/`，两种形态指的是同一枚记号。 */
const SEPARATOR_PATHS = new Set([SEPARATOR_PATH, '/'])

/**
 * **间隔**：横向的一种，界面上画成一条通栏横线，**没有图标**。
 *
 * 它本来是为**竖向排列**（书签菜单、收藏夹列表）准备的：竖排里要一条横线才隔得开。
 * 所以它的名字不是「分隔线」而是「间隔」——两个按钮必须叫得出区别，
 * 否则用户分不清自己点的是哪一个（见 docs/design.md）。
 */
export const GAP_URL = 'https://separator.mayastudios.com/index.php?t=horz'

/**
 * **分隔线**：纵向的一种，界面上显示成一枚**竖线图标**。
 *
 * 它是为**横向排列**（书签栏那一排）准备的：横排里要一条竖线才隔得开。
 * 所以它不能画成横线——那样既与它的含义相反，也看不出它其实是给书签栏用的。
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
 * 记号的种类。不是记号时返回 undefined。
 *
 * 判定按**主机名 + 路径**，路径只认 `/index.php` 与省略成 `/` 两种形态——
 * 不能只认主机名，那会把该域名下的任意页面也当成记号吃掉。
 * `?t=horz`（或写全的 `horizontal`）是横向的间隔，其余（无参数、`?t=vert`、
 * 以及早期工具写下的其他参数）一律当作纵向的分隔线——纵向本来就是默认形态。
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
 * 浏览器自带书签管理器里某个文件夹的地址。
 *
 * 主界面的「打开书签管理器」用它：在那儿能看到整棵树、也能批量整理，
 * 而扩展本来就不打算重做一套通用收藏管理（见 docs/design.md 二）。
 *
 * `?id=` 收的是 `chrome.bookmarks` 给的**数字 id**。管理器的 URL 平时显示成
 * `?id=<UUID>`（它内部用 UUID），但传数字 id 是官方支持的入口：浏览器自己的书签栏右键菜单
 * 「打开书签管理器」就是这么干的（见 issue 565829425 的复现步骤），
 * 而 `router.ts` 里的 `findIdByLegacyId()` 专门把数字 id 映射成 UUID，**映射完会改写地址栏**。
 * 所以看到 UUID 不代表数字 id 不被接受。
 *
 * 已知的地雷：**Chrome 154.x 上这个入口是坏的**（Mojo 迁移的回归，见 issue 565829425 /
 * 受限制的 565108351：传数字 id 会静默退回默认层）。修复已进 M155 并回并到 154 之前的稳定线。
 * 曾经为此把这里改成 `?q=<层名>` 搜索，何必：搜出来的是一堆结果、还要用户自己点进去，
 * 而 `?id=` 是直接落在那一层。修好之后就该用回它。
 */
export function bookmarkManagerUrl(folderId: string): string {
  return `chrome://bookmarks/?id=${encodeURIComponent(folderId)}`
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
