/**
 * 把扩展产物当静态网站跑起来，供浏览器工具预览与断言。
 *
 * 扩展页面用不了 `file://`：产物 HTML 里的 css/js 是**绝对路径**（`/pages/app.css`），
 * `file://` 下会 404。所以需要一个静态服务器。
 *
 * 用法：
 *   node tools/preview/serve.mjs [--root dist/chrome] [--port 8788] [--tree <tree.json>]
 *
 * 不给 `--tree` 就用 `sample-tree.mjs` 的合成树；给了就读真实导出（`chrome.bookmarks.getTree()`
 * 的 JSON）。真实树经 `/__tree.json` 交给 `stub.js`（桩用同步 XHR 读它）。
 *
 * **每个响应都必须带 `cache-control: no-store`**：不加时浏览器会把 js/css 缓存住，
 * 于是重新构建之后拿到的还是上一版——症状是「改了代码但断言/截图毫无变化」。
 */
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {dirname, extname, join, normalize, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {buildSampleTree} from './sample-tree.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** 极简参数解析：只认这三个开关，多一个都不加。 */
function parseArgs(argv) {
  const out = {root: join(repoRoot, 'dist', 'chrome'), port: 8788, tree: undefined}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--root') out.root = resolve(value)
    else if (key === '--port') out.port = Number(value)
    else if (key === '--tree') out.tree = resolve(value)
    else throw new Error(`未知参数：${key}（只认 --root / --port / --tree）`)
  }
  return out
}

const {root, port, tree} = parseArgs(process.argv.slice(2))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
}

const send = (res, status, type, body) => {
  res.writeHead(status, {'content-type': type, 'cache-control': 'no-store'})
  res.end(body)
}

/** 书签树与桩源码在启动时读一次，之后每次请求都发同一份。 */
const treeBody = tree
  ? await readFile(tree)
  : Buffer.from(JSON.stringify(buildSampleTree()))

const stubBody = await readFile(join(here, 'stub.js'))

createServer(async (req, res) => {
  const {pathname} = new URL(req.url, 'http://localhost')
  const path = decodeURIComponent(pathname)

  if (path === '/__tree.json') return send(res, 200, TYPES['.json'], treeBody)
  // 桩也由这里发出，而不是让调用方给出本地文件路径——
  // Playwright 的 `addInitScript({path})` 相对的是**它自己的 cwd**（在 VS Code 里是 VS Code
  // 的安装目录），拿不到仓库位置，于是那样写就只能写死一条本机绝对路径。
  if (path === '/__stub.js') return send(res, 200, TYPES['.js'], stubBody)

  // 先 normalize 再剥掉前导斜杠，否则 `..` 能穿出 root。
  const rel = normalize(path === '/' ? '/pages/app.html' : path).replace(/^[/\\]+/, '')
  const file = join(root, rel)
  try {
    send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', await readFile(file))
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', `not found: ${rel}`)
  }
}).listen(port, () => {
  console.log(`root  ${root}`)
  console.log(`tree  ${tree ?? '（合成样例树 sample-tree.mjs）'}`)
  console.log(`open  http://localhost:${port}/pages/app.html`)
})
