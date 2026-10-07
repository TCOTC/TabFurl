# AGENTS.md

AI 协作者的工程约定。**这份文件只放开发流程**（怎么构建、怎么测、代码放哪儿、提交前做什么）；
**产品行为与设计决策一律在 `docs/design.md`** —— 那是需求范围与数据模型的唯一来源，动手前先读它。

> 改动功能时**不要顺手改这份文件**：功能语义（界面怎么表现、某个 API 怎么用、文案写什么）属于
> `docs/design.md`。只有「团队怎么工作」变了（命令、构建工具、目录约定、测试方式、权限流程）才动这里。

## 这个项目是什么

浏览器扩展：把窗口的标签页存成书签文件夹（`furl`），也能把书签文件夹还原成带标签分组的窗口（`unfurl`）。书签树是唯一存储，不引入自己的数据库。

## 技术栈与硬约束

| 项 | 值 |
| --- | --- |
| 目标浏览器 | **仅 Chrome**（未做 Firefox 兼容，不要加 gecko 目标） |
| 最低 Chrome | 114（实际绑定 API 是 `tabGroups` 89；**不下调**） |
| 构建工具 | `extension` **4.1.30**（精确版本，勿升级） |
| Node | >= 22.12（extension 4.x 要求）；`pnpm test` 需要 >= 23.6（原生 TypeScript 执行 + `module.registerHooks`） |
| 包管理器 | pnpm |
| 语言 | TypeScript，无 UI 框架，纯 DOM。`strict` + `noUnusedLocals` + `noUncheckedIndexedAccess` |
| API 风格 | 直接用 `chrome.*`，MV3 原生返回 Promise；**不引入 polyfill** |
| 清单来源 | `src/manifest.json`（不要放到 `public/`，构建会直接失败） |
| 构建产物 | `dist/chrome/`（由 `extension.config.js` 锁定） |

`extension-env.d.ts` 由构建自动生成且已 gitignore，**不要手写、不要提交**。

## 常用命令

```bash
pnpm build          # 生产构建 → dist/chrome/（混淆）
pnpm dev            # 开发用构建 → dist/chrome/（不混淆，权限同样干净）
pnpm watch          # 同上，但监视 src/ 与 pages/，改完自动重建
pnpm typecheck      # 必须通过；构建本身不做类型检查，且需先 build 生成 extension-env.d.ts
pnpm test           # 单元测试（node:test，无额外依赖）
pnpm verify         # 产物自检（需先 build）：权限、host 权限、入口文件、中文编码、测试文件泄漏
pnpm preview:serve  # 起预览服务器（自己写的静态服务器，见 tools/preview/README.md）
pnpm icons          # 重新生成占位图标
```

日常开发用 `pnpm watch`：权限与生产构建一致（`pnpm verify` 照常通过），但不混淆，报错堆栈是真函数名。
⚠️ `watch` / `dev` **只构建**，不启浏览器、无热重载。重建后自己到 `chrome://extensions` 点刷新（↻）再重开主界面。
⚠️ 不给 `extension dev` / `start` / `preview` 加脚本：要下载独立 Chrome for Testing（约 150 MB），
且**必然产出开发版清单**（多 `scripting` / `management` 权限 → `pnpm verify` 必失败）。
所以 `tools/watch.mjs` 自己调 `extension build`（它本身没有 `--watch`）。
`preview:serve` 是**自己写的静态服务器**，与 `extension preview` 无关。论证见 `docs/design.md` 十。

## 目录结构

只有三条容易踩错（完整清单与文件职责见 `docs/design.md` 七）：

- `src/manifest.json` = 清单来源，**不挪到 `public/`**（构建直接失败）。
- `pages/` = 构建工具特殊目录（放「未被清单声明的 HTML」）；主界面挪回 `src/` 就不产出。
- `extension-env.d.ts` 由构建生成且已 gitignore：**不手写、不提交**。

## 工程约定

这些是「每次动手都必须知道」的流程与分层规则。**功能语义（某块界面该怎么做、某条文案写什么）
不在这里**，在 `docs/design.md`。

1. **权限最小化**：无 `host_permissions`、无 content script。加功能先问「能不能不加权限」；要加 →
   `docs/design.md` 写理由 + 同步 `tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`。
   `favicon` 是例外中的例外：只读 Chrome 本地 `_favicon` 缓存、**不联网**；已有 `tabs`，所以不多出权限警告。
2. **只用 `chrome.*`**：MV3 原生返回 Promise。不引 `browser.*`、不引 polyfill。
3. **`minimum_chrome_version: 114` 不下调**：下调 = 声明未验证的兼容性。用到更新 API 时同步抬高它 + `tools/verify-build.mjs` 的 `MIN_CHROME_VERSION`。
4. **依赖方向单向，模块不互相 import**：`pages/` → `src/app/` → `src/shared/`；`shared/` 不许 import 界面模块。
   面板间只走 `dom.ts` 的 `AppEvents`；谁刷新、跳哪里由 `App.ts` 定。
   「别处的当前值」（如 chip 栏要知道这一栏站在哪）由 `App.ts` 递**取值函数**进去——
   那是查询不是事件，→ 不进 `AppEvents`。可直接 import 的工具模块只有三个：
   `BookmarkDialog.ts` / `FolderPicker.ts` / `icons.ts`。
5. **同一件事只写一处，不许有第二份定义**：命名规则只在 `shared/naming.ts`（界面层不许自己拼字符串）；
   「是不是书签 / 会不会被打开 / 是不是记号」的判定只在 `shared/bookmarks.ts` 与 `shared/urls.ts`；
   图标只有一份在 `src/app/icons.ts`；颜色 / 字号 / 间距与一行条目的排版走 `shared/base.css` 的变量与 `.item*`。
   同一件事写两遍，必然在某次改动之后分叉，而症状总是「按钮上的数字与列表对不上」。
6. **测试只用 `node:test`**：不引 vitest / jest / tsx。测试与实现同目录（`naming.test.ts`）；`chrome.*` 靠给 `globalThis.chrome` 赋值打桩，不给产品代码加注入。
   **取值用 `at()` 而不是 `!`**：`noUncheckedIndexedAccess` 下 `items[i]` 是 `T | undefined`——那是对的
      （越界真的可能），所以测试里用各文件自带的 `at(items, i)` 把「我认为这里有值」写成一条断言；
      `!` 会把错的假设吞掉。同一表达式里要两次取值时先存局部变量，否则判别式收窄不成立。
   **新代码别把 `let` 写成 `const` 或反之**：`let` 只给真会重新赋值的东西（全仓约 1:8）。
7. **改功能时不要顺手改这份文件**：界面行为、API 用法、文案口径都是会随功能变的东西，
   写在 `docs/design.md`。这份文件只回答「代码放哪儿、怎么建、怎么测、提交前做什么」。

## 调试与验证

- **界面层（`src/app/`）没有单元测试**，唯一的自动验证手段是预览桩：`pnpm build` → `pnpm preview:serve`，
  用法与**四条测量纪律**见 `tools/preview/README.md`。最常踩的一条是：
  **合成事件里的 `DataTransfer.dropEffect` 读回来永远是 `'none'`**（它由浏览器在真实拖拽会话里管理，
  而 `new DragEvent(...)` 没有会话）→ 这个读数**没有任何区分力**。要验「这个落点收不收」，看 DOM 里的
  `.is-drop-*` 标记数、`event.defaultPrevented`（拒收的分支是提前 `return`）、或预览桩 `__calls` 里有没有真的 `move`。
- `pnpm verify` 是本项目唯一能自动拦住「权限悄悄变多」的关卡。**任何让它常态化变红的开发流程，
  都等于没有这道关卡**——所以 `watch` / `dev` 也必须产出干净权限。

## 提交前自检

```bash
pnpm test && pnpm build && pnpm typecheck && pnpm verify
```

`build` 必须排在 `typecheck` 前：`extension-env.d.ts`（`chrome` 全局类型与 `*.css` 模块声明的来源）由构建生成且不入库。
新 clone 后直接跑 `pnpm typecheck` 会报一堆 `Cannot find name 'chrome'`。

`pnpm verify` 里有一份期望权限集（`tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`），并拦 Firefox 字段残留。
**动权限就必须同时改它和 `docs/design.md` 的权限表**，不一致会被自检挡下来。

## 不要做的事

- 不为「顺手」把功能扩到通用收藏管理（标签、笔记、全文检索）——那是另一个产品。
- **不为 Firefox 做适配**：唯一目标是 Chrome；不加 gecko 目标、不加 `firefox:` 前缀字段、不做特征检测降级。
- 不引 UI 框架或状态管理库；界面很小，纯 DOM 够用。
- 不用 `chrome.tabs.query({})` 这类无过滤全量查询，也不读标签页内容（不需要 `scripting`）。
- 不在 `shared/` 里搞 `globalThis.chrome` 可空兼容层：Chrome 下 `chrome` 一定存在。
