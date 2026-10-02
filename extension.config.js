/** @type {import('extension').FileConfig} */
// 本项目只做 Chrome（未做 Firefox 兼容，不要加 gecko 目标）。
// profile 放到 dist/ 下，让登录态在多次 dev 之间保留（dist/ 已被 git 忽略）。
const profile = './dist/extension-profile-chrome'

// CI 环境没有沙箱和 GPU，必须显式关掉对应开关。
const ciFlags = process.env.CI ? ['--no-sandbox', '--disable-gpu'] : []

export default {
  browser: {
    chrome: {profile, browserFlags: ciFlags}
  },
  // 四个命令都锁定 chrome，产物固定落在 dist/chrome。
  commands: {
    dev: {browser: 'chrome'},
    start: {browser: 'chrome'},
    preview: {browser: 'chrome'},
    build: {browser: 'chrome'}
  }
}
