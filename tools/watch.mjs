/**
 * 自动编译：`pnpm watch`。
 *
 * 改 `src/` 或 `pages/` 下的文件后自动重新构建 `dist/chrome/`，省掉手动跑 `pnpm dev`。
 * 浏览器侧仍需自己点扩展卡片上的刷新（↻）——本脚本不碰浏览器，也不需要下载 Chrome for Testing。
 *
 * 为什么不直接用 `extension dev --no-browser`：它会产出开发版清单，多出 `scripting` 与
 * `management` 两个权限并写入 CSP，导致 `pnpm verify` 失败；而本项目的第 1 条约定是权限最小化。
 * 这里走 `extension build --mode development`，权限与生产构建完全一致。
 */
import {spawn} from 'node:child_process'
import {watch} from 'node:fs'
import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)
/**
 * CLI 入口。`extension` 包的 `exports["."]` 就是 CLI 本体（`dist/cli.cjs`），
 * 直接解析它可避免经过 `.bin/*.cmd` 的 shell 引号问题。
 * 注意不能写 `extension/bin/extension.cjs`——那个子路径没有被 `exports` 暴露。
 */
const CLI = require.resolve('extension')

/** 参与构建的目录。`tools/` 与文档改动不触发重建。 */
const WATCHED_DIRS = ['src', 'pages']

/** 只对会进产物的文件类型触发。测试文件不参与构建，跳过以免白跑。 */
const RELEVANT = /\.(ts|css|html|json|png|jpg|jpeg|gif|webp|svg|ico)$/i
const IGNORED = /\.test\.[cm]?[jt]s$/i

/** 编辑器保存常触发多次事件，合并一下。 */
const DEBOUNCE_MS = 150

let building = false
let pending = false
let timer

function build(reason) {
  if (building) {
    // 编译期间又有改动：记下来，等这轮结束再跑一次，别丢事件。
    pending = true
    return
  }

  building = true
  const startedAt = Date.now()

  const child = spawn(process.execPath, [CLI, 'build', '--mode', 'development'], {
    stdio: ['ignore', 'ignore', 'inherit']
  })

  child.on('close', (code) => {
    building = false
    const elapsed = Date.now() - startedAt

    if (code === 0) {
      const time = new Date().toTimeString().slice(0, 8)
      console.log(`[${time}] 已重新构建 dist/chrome/（${elapsed} ms，${reason}）`)
      console.log('          去 chrome://extensions 点扩展卡片上的刷新（↻）')
    } else {
      console.error(`构建失败（退出码 ${code}），产物可能仍是上一版。`)
    }

    if (pending) {
      pending = false
      build('编译期间的改动')
    }
  })
}

function onChange(filename) {
  if (!filename) return
  // fs.watch 给的是相对被监视目录的路径，可能带反斜杠或正斜杠。
  const name = String(filename).replace(/\\/g, '/')
  if (IGNORED.test(name)) return
  if (!RELEVANT.test(name)) return

  clearTimeout(timer)
  timer = setTimeout(() => build(name), DEBOUNCE_MS)
}

for (const dir of WATCHED_DIRS) {
  watch(dir, {recursive: true}, (_event, filename) => onChange(filename))
}

console.log('正在监视 src/ 与 pages/，改动后自动重建 dist/chrome/。')
console.log('按 Ctrl+C 停止。')

// 先跑一次，保证 dist/chrome 是最新的（首次 clone 后也能直接加载）。
build('启动时的首次构建')
