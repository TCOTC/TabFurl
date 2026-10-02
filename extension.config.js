/** @type {import('extension').FileConfig} */
// 本项目只做 Chrome（未做 Firefox 兼容，不要加 gecko 目标）。
//
// 只保留 build。`dev` / `start` / `preview` 都要求先下载独立的 Chrome for Testing
// （约 150 MB，`pnpm exec extension install chrome`），换来的是热重载与一套控制桥
// （logs / open / reload / eval / storage）。本项目不做自动化验收，所以没有留脚本。
// 需要时临时跑 `pnpm exec extension dev`，但要知道：
//   - 它会把 dist/chrome 换成开发版清单（多出 `scripting` 与 `management` 权限）
//   - 跑完要再 `pnpm build` 一次，才能拿到可自检、可对外分发的产物
//
// 日常开发用 `pnpm build:dev`：权限同样干净，但不混淆，报错堆栈里是真实函数名。
const ciFlags = process.env.CI ? ['--no-sandbox', '--disable-gpu'] : []

export default {
  // 只在临时启用 dev / start / preview 时用到；build 不启动浏览器。
  browser: {
    chrome: {browserFlags: ciFlags}
  },
  // 必须锁定 chrome：否则 build 按默认的 chromium 产出 dist/chromium，
  // 而 tools/verify-build.mjs 是按 dist/chrome 自检的。
  commands: {
    build: {browser: 'chrome'}
  }
}
