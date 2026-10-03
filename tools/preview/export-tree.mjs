/**
 * 把 Chrome 的真实书签文件转成预览桩能直接用的形状。
 *
 * 为什么需要转换：Chrome 自己的 `Bookmarks` 文件里字段叫 `name`，而 `chrome.bookmarks.getTree()`
 * 返回的（也是桩与界面用的）叫 `title`；文件顶层是 `{roots: {...}}`，而 API 返回的是一个数组。
 * 拿去喂 `pnpm preview:serve --tree` 之前必须先过这一手。
 *
 * 用法：
 *   node tools/preview/export-tree.mjs --out tree.json
 *   node tools/preview/export-tree.mjs --out tree.json --bookmarks "<某个 profile 的 Bookmarks 文件>"
 *
 * 不给 `--bookmarks` 时按 Windows 默认安装的 `Default` profile 找。**输出的树含你的真实书签**，
 * 所以别把它提交进仓库（仓库根已有 `.gitignore` 覆盖不到它 —— 写到 `%TEMP%` 或别的临时位置）。
 *
 * 顺带把书签栏那一层的形态打出来（文件夹 / 记号 / 书签的序列），
 * 用来核对它与 `sample-tree.mjs` 的合成树是否还对得上。
 */
import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

function parseArgs(argv) {
  const out = {out: undefined, bookmarks: undefined}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--out') out.out = value
    else if (key === '--bookmarks') out.bookmarks = value
    else throw new Error(`未知参数：${key}（只认 --out / --bookmarks）`)
  }
  if (!out.out) throw new Error('必须给 --out <输出路径>')
  return out
}

const {out, bookmarks} = parseArgs(process.argv.slice(2))

const source =
  bookmarks ??
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks')

let raw
try {
  raw = JSON.parse(readFileSync(source, 'utf8'))
} catch (error) {
  throw new Error(
    `读不到 Chrome 书签文件：${source}\n` +
      `（Chrome 没在运行时这个文件也还在；换 profile 或换个浏览器用 --bookmarks 指过去）\n` +
      String(error)
  )
}

/** `name` → `title`；只留 id / title / url / children。 */
const convert = (node) => {
  const result = {id: node.id, title: node.name ?? ''}
  if (node.url) result.url = node.url
  if (node.children) result.children = node.children.map(convert)
  return result
}

const roots = Object.values(raw.roots ?? {}).map(convert)
// 与真实 `chrome.bookmarks.getTree()` 一致：外面再包一层根，id 是 `0`。
const payload = [{id: '0', title: '', children: roots}]
writeFileSync(out, JSON.stringify(payload), 'utf8')

const bar = roots.find((root) => root.id === '1')
const children = bar?.children ?? []
const shape = (node) => (!node.url ? 'F' : /separat/i.test(node.url) ? '|' : 'b')
const kinds = children.map(shape)

console.log(`已写出 ${out}`)
console.log(`书签栏子级：${children.length}`)
console.log(`形态（F=文件夹 |=记号 b=书签）：${kinds.join('')}`)
console.log(`记号下标：${kinds.map((k, i) => (k === '|' ? i : -1)).filter((i) => i >= 0).join(',')}`)
console.log(`真书签 / 子文件夹：${kinds.filter((k) => k === 'b').length} / ${kinds.filter((k) => k === 'F').length}`)
console.log(`前 8 个子级：${children.slice(0, 8).map((c) => c.title).join(' / ')}`)
