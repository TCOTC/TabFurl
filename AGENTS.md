# AGENTS.md

给 AI 协作者（以及未来的自己）的工程约定。**动手前先读 `docs/design.md`**，那里是需求范围与数据模型的唯一来源。

## 这个项目是什么

浏览器扩展：把窗口的标签页存成书签文件夹（`furl`），也能把书签文件夹还原成带标签分组的窗口（`unfurl`）。书签树是唯一存储，不引入自己的数据库。

## 技术栈与硬约束

| 项 | 值 |
| --- | --- |
| 目标浏览器 | **仅 Chrome**（未做 Firefox 兼容，不要加 gecko 目标） |
| 最低 Chrome | 114（`sidePanel` 的要求，写在 `minimum_chrome_version`） |
| 构建工具 | `extension` **4.1.30**（精确版本，勿升级） |
| Node | >= 22.12（extension 4.x 要求）；`pnpm test` 需要 >= 23.6（原生 TypeScript 执行 + `module.registerHooks`） |
| 包管理器 | pnpm |
| 语言 | TypeScript，无 UI 框架，纯 DOM |
| API 风格 | 直接用 `chrome.*`，MV3 原生返回 Promise；**不引入 polyfill** |
| 清单来源 | `src/manifest.json`（不要放到 `public/`，构建会直接失败） |
| 构建产物 | `dist/chrome/`（由 `extension.config.js` 锁定） |

`extension-env.d.ts` 由构建自动生成且已 gitignore，**不要手写、不要提交**。

## 常用命令

```bash
pnpm build          # 生产构建 → dist/chrome/（混淆）
pnpm dev            # 开发用构建 → dist/chrome/（不混淆，权限同样干净）
pnpm typecheck      # 必须通过；构建本身不做类型检查，且需先 build 生成 extension-env.d.ts
pnpm test           # 单元测试（node:test，无额外依赖）
pnpm verify         # 产物自检（需先 build）：权限、host 权限、入口文件、中文编码、测试文件泄漏
pnpm icons          # 重新生成占位图标
```

日常开发用 `pnpm dev`：权限与生产构建完全一致（所以 `pnpm verify` 照常通过），但不混淆，
浏览器里报错时的堆栈是真实函数名。代价只是体积大一倍（都是本地产物，无所谓）。

⚠️ **它只构建，不启动浏览器、也没有热重载。** 名字取短是为了顺手，背后是
`extension build --mode development`。改完代码要重新跑 `pnpm dev`，再去扩展页点卡片上的刷新（↻）。

**`extension dev` / `start` / `preview` 没有做成脚本**（2026-10-02 决定）。它们都要求先下载独立的
Chrome for Testing（约 150 MB，`pnpm exec extension install chrome`），换来的是热重载与一套控制桥
（`logs` / `open` / `reload` / `eval` / `storage`）。本项目不做自动化验收，于是换成「手动加载
`dist/chrome` + 点扩展卡片的刷新」，省掉一个重依赖。哪天要做自动化了，命令随时可以加回来。

需要时临时跑 `pnpm exec extension dev`，但要知道两件事（2026-10-02 实测）：

1. **它不启动你系统里的 Chrome**，只用托管缓存里的 Chrome for Testing。没装时浏览器起不来，
   而 dev server 会照常打印「ready」并继续挂着——只看这一行容易误判成功。
2. **它会把 `dist/chrome` 覆盖成开发版产物**：清单里多出 `scripting` 与 `management` 权限，
   并写入 `extension-js-control.json`。此时 `pnpm verify` 必然报「权限与预期不一致」。
   所以 **`dev` 之后要再跑一次 `pnpm build`**，才能拿到可自检、可对外分发的干净产物。

## 目录结构

```
src/
  manifest.json     入口声明（纯 MV3，不含任何 browser-prefixed 字段）
  background.ts     只负责「点图标 → 开侧边栏」
  shared/           与界面无关的核心逻辑，全部可独立复用
    types.ts        领域类型 + 默认设置
    naming.ts       文件夹命名规则（纯函数，无 IO）
    urls.ts         URL / 主机名 / 占位块小工具
    bookmarks.ts    书签树读写与展开
    capture.ts      窗口 → 书签
    restore.ts      书签 → 窗口 / 标签页
    settings.ts     Chrome storage 读写
    tile.ts         占位块 HTML 生成
    base.css        全站共用的设计变量与基础组件
    *.test.ts       与实际文件同目录的单元测试（node:test，给 chrome.* 打桩）
  sidebar/          主界面（侧边栏）
  options/          设置页
  images/           图标
pages/
  folder.html/.ts   收藏文件夹阅读页（由特殊文件夹 pages/ 编译，路径即 pages/folder.html）
tools/
  generate-icons.mjs 占位图标生成器（纯 Node，无第三方依赖）
  verify-build.mjs   产物自检
  ts-hooks.mjs       测试专用的 TS 解析钩子（给无扩展名的相对导入补 .ts）
```

## 不可破坏的约定

1. **权限最小化**：当前不需要任何 `host_permissions`，也没有 content script。加功能时先问「能不能不加权限」，新增权限必须在 `docs/design.md` 里写理由，并同步 `tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`。
2. **只用 `chrome.*`**：MV3 下这些 API 原生返回 Promise，不再需要 `webextension-polyfill`。不要为了「保持中立」而引入 `browser.*` 或 polyfill。
3. **依赖 `minimum_chrome_version: 114`**：`chrome.sidePanel` 与 `chrome.tabGroups` 因此可直接调用，不需要特征检测。若将来用到更新的 API，必须同步抬高此版本号。
4. **命名规则只在 `shared/naming.ts` 里实现**：界面层不得自己拼字符串。规则见 `docs/design.md`。
5. **`shared/` 不允许 import `sidebar/`、`options/`、`pages/`**：依赖方向只能是从界面到核心。
6. **`bookmarks` API 的 id 是设备本地的**：同一账号在另一台设备上 id 不同。任何持久化数据都不要以书签 id 作为跨设备稳定的标识；id 只允许存在本地设置里（如 `archiveRootId`），且必须能重建。
7. **写入书签前先过滤内部页面**（`chrome://`、`chrome-extension://`、`devtools://` 等），用 `isInternalUrl()`。
8. **同名不覆盖**：建文件夹前先用 `dedupeName()` 对同级已有名字去重。
9. **样式**：所有颜色和间距走 `base.css` 的 CSS 变量，不写死色值；深色模式靠 `prefers-color-scheme`，不要单独维护两套。
10. **测试只用 `node:test`**：不引入 vitest / jest / tsx 等框架。测试文件与实现同目录（`naming.test.ts`），`chrome.*` 靠给 `globalThis.chrome` 赋值来打桩，不给产品代码加依赖注入。
11. **会话文件夹的直接子级必须按窗口顺序排列**：标签分组建子文件夹，未分组的标签建成散装书签插在原位，**不要**把它们收进「未分组」文件夹。两个实现是逆运算，改一处必须同步另一处：`capture.ts` 的 `planSessionChildren()` ↔ `restore.ts` 的 `planRestore()`（前者按 `TabSnapshot.index` 归并，后者按子级数组顺序还原）。

## 提交前自检

```bash
pnpm test && pnpm build && pnpm typecheck && pnpm verify
```

`build` 必须排在 `typecheck` 前面：`extension-env.d.ts`（`chrome` 全局类型与 `*.css` 模块声明的来源）由构建生成且不入库。新 clone 后直接跑 `pnpm typecheck` 会报一堆 `Cannot find name 'chrome'`。

`pnpm verify` 里有一份期望的权限集（`tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`），并会主动拦截 Firefox 字段残留。**动权限就必须同时改它和 `docs/design.md` 的权限表**，两处不一致会被自检挡下来。

## 不要做的事

- 不要为了「顺手」把功能扩展到通用收藏管理（标签、笔记、全文检索）——那是另一个产品。
- **不要为 Firefox 做适配**。目标浏览器只有 Chrome；不加 gecko 目标、不加 `firefox:` 前缀字段、不做特征检测降级。
- 不要引入 UI 框架或状态管理库；三个界面都很小，纯 DOM 足够。
- 不要用 `chrome.tabs.query({})` 这类无过滤的全量查询，也不要读取标签页内容（不需要 `scripting` 权限）。
- 不要在 `shared/` 里搞 `globalThis.chrome` 的可空兼容层：Chrome 下 `chrome` 一定存在，直接用。
