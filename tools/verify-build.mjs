/**
 * 构建产物自检：`pnpm verify`（需先 `pnpm build`）。
 *
 * 检查的都是「构建能过、但装到浏览器里才发现」的问题：
 * 权限漂移、混进 host 权限、清单残留 Firefox 字段、入口文件缺失、中文被写坏、测试文件泄漏进产物。
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs'

const DIST = 'dist/chrome'

/** 期望的权限集：多一个都算漂移，必须同步更新 docs/design.md。 */
const EXPECTED_PERMISSIONS = ['bookmarks', 'tabs', 'tabGroups', 'storage', 'favicon']

/** 清单里必须指向这些文件的入口。 */
const EXPECTED_ENTRIES = {
  'background.service_worker': 'background/service_worker.js',
  action: 'images/icon-128.png'
}

const EXPECTED_FILES = [
  'manifest.json',
  'background/service_worker.js',
  'shared/commons.js',
  'pages/app.html',
  'pages/app.js',
  'pages/app.css',
  'pages/folder.html',
  'pages/folder.js',
  'pages/folder.css',
  'images/icon-16.png',
  'images/icon-32.png',
  'images/icon-48.png',
  'images/icon-64.png',
  'images/icon-128.png'
]

const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

const manifestPath = `${DIST}/manifest.json`
if (!existsSync(manifestPath)) {
  console.error(`${manifestPath} 不存在，先跑 pnpm build`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

check(
  manifest.manifest_version === 3,
  `manifest_version 应为 3，实际 ${manifest.manifest_version}`
)

// 本项目只做 Chrome；出现 Firefox 字段说明清单没清干净。
for (const key of Object.keys(manifest)) {
  check(!key.startsWith('firefox:'), `清单里残留 Firefox 前缀字段：${key}`)
}
check(!('browser_specific_settings' in manifest), '清单里残留 browser_specific_settings')
check(!('browser_action' in manifest), '清单里残留 browser_action')
check(!('sidebar_action' in manifest), '清单里残留 sidebar_action')
// 主界面已改成独立标签页（pages/app.html）；side_panel 一旦回流，页面就会以窄面板渲染。
check(!('side_panel' in manifest), '清单里残留 side_panel（主界面已改为 pages/app.html）')

// 本项目承诺不申请任何 host 权限；一旦出现就是设计事故。
check(!('host_permissions' in manifest), '出现了 host_permissions，这是本项目明确不允许的')
check(!('optional_host_permissions' in manifest), '出现了 optional_host_permissions')

const actual = [...(manifest.permissions ?? [])].sort()
const wanted = [...EXPECTED_PERMISSIONS].sort()
check(
  JSON.stringify(actual) === JSON.stringify(wanted),
  `权限与预期不一致\n    预期 ${wanted.join(', ')}\n    实际 ${actual.join(', ')}`
)

const readPath = (path) => path.split('.').reduce((value, key) => value?.[key], manifest)
for (const [path, marker] of Object.entries(EXPECTED_ENTRIES)) {
  const value = readPath(path)
  check(value !== undefined, `清单缺少 ${path}`)
  if (value !== undefined) {
    check(
      JSON.stringify(value).includes(marker),
      `${path} 未指向 ${marker}（实际 ${JSON.stringify(value)}）`
    )
  }
}

// 移除 sidePanel 后，本项目实际用到的最高 API 要求是 tabGroups（89+）。
// 这里仍要求 114：不下调以免声明未经验证的旧版本兼容性；升上去则必须同步抬高。
const MIN_CHROME_VERSION = 114
const minVersion = Number(manifest.minimum_chrome_version)
check(
  Number.isFinite(minVersion) && minVersion >= MIN_CHROME_VERSION,
  `minimum_chrome_version 应 >= ${MIN_CHROME_VERSION}，实际 ${manifest.minimum_chrome_version}`
)

for (const file of EXPECTED_FILES) {
  check(existsSync(`${DIST}/${file}`), `缺少产物 ${file}`)
}

// `*.test.ts` 只给 `node --test` 用。它们没被任何入口引用，理应不进产物；
// 一旦出现在这里，说明有人从界面代码里 import 了测试文件。
const packaged = readdirSync(DIST, {recursive: true}).map(String)
for (const file of packaged) {
  check(!/\.test\.[cm]?[jt]s$/.test(file), `产物里混进了测试文件：${file}`)
}

// 中文描述被写坏时构建不会报错，装到浏览器里才会显形。
const description = manifest.description ?? ''
check(
  !description.includes('\uFFFD') && /[\u4e00-\u9fff]/.test(description),
  `description 中文可能已损坏（${description}）`
)

console.log(`  ${manifest.name} ${manifest.version} — 权限 ${actual.join(', ')}`)
console.log(`  minimum_chrome_version ${manifest.minimum_chrome_version}`)

if (failures.length > 0) {
  console.error('\n自检未通过：')
  for (const failure of failures) console.error(`  x ${failure}`)
  process.exit(1)
}

console.log('\n自检通过：产物齐全、无 host 权限、无 Firefox 残留、权限集与 docs/design.md 一致。')


