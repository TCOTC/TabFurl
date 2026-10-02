# AGENTS.md

给 AI 协作者（以及未来的自己）的工程约定。**动手前先读 `docs/design.md`**，那里是需求范围与数据模型的唯一来源。

## 这个项目是什么

浏览器扩展：把窗口的标签页存成书签文件夹（`furl`），也能把书签文件夹还原成带标签分组的窗口（`unfurl`）。书签树是唯一存储，不引入自己的数据库。

## 技术栈与硬约束

| 项 | 值 |
| --- | --- |
| 目标浏览器 | **仅 Chrome**（未做 Firefox 兼容，不要加 gecko 目标） |
| 最低 Chrome | 114（见下方第 3 条；移除 `sidePanel` 后实际绑定 API 是 `tabGroups` 的 89，此处不下调） |
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
pnpm watch          # 同上，但监视 src/ 与 pages/，改完自动重建
pnpm typecheck      # 必须通过；构建本身不做类型检查，且需先 build 生成 extension-env.d.ts
pnpm test           # 单元测试（node:test，无额外依赖）
pnpm verify         # 产物自检（需先 build）：权限、host 权限、入口文件、中文编码、测试文件泄漏
pnpm icons          # 重新生成占位图标
```

日常开发用 `pnpm watch`：权限与生产构建完全一致（所以 `pnpm verify` 照常通过），但不混淆，
浏览器里报错时的堆栈是真实函数名；改完代码它会自动重建。代价只是体积大一倍（都是本地产物，无所谓）。

⚠️ **`watch` / `dev` 只构建，不启动浏览器、也没有热重载。** 名字取得短是为了顺手。
自动重建之后仍需自己去 `chrome://extensions` 点扩展卡片上的刷新（↻）再重开主界面标签页。

**`extension dev` / `start` / `preview` 没有做成脚本**（2026-10-02 决定）。它们都要求先下载独立的
Chrome for Testing（约 150 MB，`pnpm exec extension install chrome`），换来的是浏览器自动加载与热重载。
本项目不做自动化验收，于是换成「`pnpm watch` + 手动点刷新」，省掉一个重依赖。

顺带记下两条实测结论，免得以后再试一遍：

- `extension build` **没有 `--watch`**，真正的监视能力只存在于 `dev` 里。
- `extension dev --no-browser` 确实能只监视不启动浏览器（日志显示 `Chrome (no-browser mode)`），
  但它**必然产出开发版清单**——多出 `scripting` 与 `management` 两个权限并写入 CSP，
  `pnpm verify` 会失败；`--no-reload` 也去不掉这两个权限。
  这就是 `tools/watch.mjs` 自己调 `extension build` 而不用 `dev --no-browser` 的原因。

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
  background.ts     只负责「点图标 → 在独立标签页里打开主界面」
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
  app/              主界面的界面模块（只被 pages/app.ts 引用）
    App.ts          外壳：顶部两个 Tab + 存档位置选择器、面板装配、跳面板刷新
    ArchiveRootPicker.ts 存档位置选择器（挂在标签栏旁，选择即落盘）
    CapturePanel.ts 保存面板
    ArchivePanel.ts 存档面板
    dom.ts          面板契约（Panel / AppEvents）与共用小工具
  images/           图标
pages/
  app.html/.ts      主界面入口（独立标签页；由特殊文件夹 pages/ 编译，路径即 pages/app.html）
  folder.html/.ts   收藏文件夹阅读页（同上，路径即 pages/folder.html）
tools/
  generate-icons.mjs 占位图标生成器（纯 Node，无第三方依赖）
  verify-build.mjs   产物自检
  watch.mjs          自动重建（监视 src/ 与 pages/，纯 Node）
  ts-hooks.mjs       测试专用的 TS 解析钩子（给无扩展名的相对导入补 .ts）
```

## 不可破坏的约定

1. **权限最小化**：当前不需要任何 `host_permissions`，也没有 content script。加功能时先问「能不能不加权限」，新增权限必须在 `docs/design.md` 里写理由，并同步 `tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`。
   现有权限里 `favicon` 是例外中的例外：它**只读 Chrome 本地缓存、不联网**（`_favicon` 端点），而且因为已经有 `tabs`，它不会多出权限警告。
2. **只用 `chrome.*`**：MV3 下这些 API 原生返回 Promise，不再需要 `webextension-polyfill`。不要为了「保持中立」而引入 `browser.*` 或 polyfill。
3. **`minimum_chrome_version: 114` 是保守下限，不要下调**：本项目实际用到的最高 API 要求是 `chrome.tabGroups`（89），移除 `sidePanel` 后 114 已无强制理由，但下调等于声明未经验证的旧版本兼容性。若将来用到更新的 API，必须同步抬高此版本号，并同步 `tools/verify-build.mjs` 的 `MIN_CHROME_VERSION`。
4. **命名规则只在 `shared/naming.ts` 里实现**：界面层不得自己拼字符串。规则见 `docs/design.md`。
5. **依赖方向单向，且面板之间不互相 import**：`pages/` → `src/app/` → `src/shared/`。`shared/` 不得 import 任何界面模块；
   `src/app/` 下的两个面板只通过 `dom.ts` 的 `AppEvents` 通信（谁该刷新由 `App.ts` 决定），互不引用，免得绕成环。
   存档位置选择器不是面板（它不被 `AppEvents` 驱动，而是驱动 `settingsChanged`），由 `App.ts` 直接挂在标签栏旁边。
6. **`bookmarks` API 的 id 是设备本地的**：同一账号在另一台设备上 id 不同。任何持久化数据都不要以书签 id 作为跨设备稳定的标识；id 只允许存在本地设置里（如 `archiveRootId`），且必须能重建。
7. **写入书签前先过滤内部页面**（`chrome://`、`chrome-extension://`、`devtools://` 等），用 `isInternalUrl()`。
8. **同名不覆盖**：建文件夹前先用 `dedupeName()` 对同级已有名字去重。
9. **样式**：颜色、字号、间距一律走 `base.css` 的变量（`--space-1..6`、`--text-xs/sm/md/lg`），不写死数值；深色模式靠 `prefers-color-scheme`，不单独维护两套。
   一行条目（前置控件/图标 + 标题 + 副文案 + 尾部说明）用 `base.css` 的 `.item` / `.item__main` / `.item__title` / `.item__meta`，
   别在页面样式里重写一遍 flex 与省略号——那种重复每多一处就会漏掉一次 `min-width: 0`（省略号就失效了）。
   **盒子套盒子时，外圆角 = 内圆角 + 内边距**（写成 `calc(内圆角 + 内边距)`，别各写一个值）：差值不对，内块的四个角就会顶到外框的弧线上。
10. **测试只用 `node:test`**：不引入 vitest / jest / tsx 等框架。测试文件与实现同目录（`naming.test.ts`），`chrome.*` 靠给 `globalThis.chrome` 赋值来打桩，不给产品代码加依赖注入。
11. **会话文件夹的直接子级必须按窗口顺序排列**：标签分组建子文件夹，未分组的标签建成散装书签插在原位，**不要**把它们收进「未分组」文件夹。两个实现是逆运算，改一处必须同步另一处：`capture.ts` 的 `planSessionChildren()` ↔ `restore.ts` 的 `planRestore()`（前者按 `TabSnapshot.index` 归并，后者按子级数组顺序还原）。
12. **界面不得自己遍历标签／书签树**：勾选清单直接用 `planSessionChildren()` / `planRestore()` 的产物渲染，
    「将保存／将还原 N 个」也由 `countSnapshotTabs(selectTabs(...))` / `applyExclusions()` 算。
    一旦界面自己走一遍树，顺序或过滤口径就会与写入/还原脱钩——这是第 11 条那一对函数新增消费方时最容易出的错。
13. **存档位置由用户在书签栏里指定，扩展不建文件夹**：存档根的候选只来自 `getBookmarksBarId()`（认 id `1`，认不出就报错），**绝不退化为「其他书签」**。不要给扩展加「自动创建 / 迁移存档根」这类行为。
    它由 `src/app/ArchiveRootPicker.ts` 选择，**挂在标签栏旁边（不在面板里）**：保存与存档两块都要用它，塞进任一块都会让另一块看起来没配置。选择即落盘，没有「保存设置」这一步。
14. **还原去向是按钮，不是存起来的偏好**：打开标签去哪里（新窗口 / 当前窗口）属于「这一次要开到哪里」，同一个存档两次可能选得不一样，所以做成两个按钮。
    **不要把它加回 `Settings`**，也不要为了省一个按钮而合并它们。「只开标签页」固定开新窗口：它与「还原到新窗口」是同一件事的轻重两档，都不打断正在用的窗口。
    阅读页（`pages/folder.ts`）同样给出这两个按钮。
15. **勾选用「排除集」而不是「选中集」**：默认什么都不排除，界面上才不会在每次重渲染后把用户没碰过的项弄丢。标签用 `TabSnapshot.tabId`（标签存活期间不变），书签用书签 id；**不要用 `TabSnapshot.index`**，它会被别的标签关闭而整体前移。
    两侧的**默认值相反，是刻意的**：保存侧默认全选（语义就是「把当前窗口收起来」）；存档侧默认一个都不勾（还原是「要打开哪些」，默认全开太危险，而且刚存完的存档不该被下一次还原顺手打开）。
    存档侧的「默认不勾」仍用排除集实现：多维护一份「见过的书签 id」（`knownBookmarks`），没见过的默认算排除。
    换成选中集就不能两头都对——所以别改。
16. **三态勾选框用原生 `indeterminate`，但点击意图要自己推**：
    `indeterminate` 是 **DOM 属性**（写不进 `innerHTML`，必须建好元素再用 JS 设），所以原生 checkbox 本来就支持三态，不需要自定义控件。
    但点击时**不要读原生结果**——原生只是把 `checked` 取反，于是「部分选择」（`checked` 为真）会变成「全不选」，与惯例相反。
    用 `dom.ts` 的 `triState()` / `nextSelectAll()` 推：全选 → 全不选，部分与全不选 → 全选。三层（顶层、存档/分组、标签）用同一套规则。
17. **叶子勾选框的状态必须在渲染后手工同步**：`innerHTML` 写不出 `checked`，所以叶子渲染出来一律是未勾选。
    若忘了在 `applyContainerStates()` / `syncStates()` 里按模型回填，症状是**叶子永远显示未勾选**，
    而点一下反而把「未排除」改成「勾上」——看上去完全没反应。容器（三态）也必须回填，否则它会与实际状态脱钩。
18. **勾选只有一个维度**：不要同时维护「哪些项被选中」与「哪些项被排除」两套集合——
    那会让列表看着全选、而按钮说没选中。统一用「排除集」，各层三态由它聚合出来。
19. **副文案不能拿「还会还原的枚数」当「有几个标签」写**：存档侧默认不勾，那样写会显示成「0 个标签」，
    看着像这个存档是空的。要以「已选」为主：`未勾选 · 共 5 枚标签` / `已选 2 / 5 枚标签` / `已全选 5 枚标签`。
20. **分隔线是记号，不是书签**：`isSeparatorUrl()`（`shared/urls.ts`）认出的那个占位书签，在阅读页与存档面板里都画成一条横线（有标题就嵌在线的正中），**不计入任何枚数、没有勾选框、还原时跳过**，也不算 `skipped`。
    判定只看主机名 + 路径（忽略协议、查询串、片段），别改成只认主机名。
    渲染标题前过一道 `separatorTitle()`：**首尾的 `─` 与空白一起去掉**（`──── 工作 ────` 这类手画的线会与 CSS 画的线打架），
    整条都是横杠时退化成无标题、只画一根线。别只剥横杠再 `trim()`——`─ ─ ─` 会剩下中间那根。
    实现在两处界面 + `restore.ts` 的 `PlannedBookmark.separator`；新增任何「数标签」的地方都必须走 `restorableBookmarks()`，否则枚数会在分隔线上对不上。
21. **主界面只允许有一个滚动容器**：`.app--shell` 把整页锁在一屏内（`100dvh`），滚动交给 `.pick-list` / `.tree`（`flex: 1; min-height: 0; overflow-y: auto`），
    这样顶部标签栏与底部按钮始终可见。**不要给列表加 `max-height`**——那会与页面滚动叠成两条滚动条，而且列表一长，底部按钮就被推出屏幕。
    阅读页（`folder.html`）不加 `app--shell`：它就是要整页往下读的文档。

## 提交前自检

```bash
pnpm test && pnpm build && pnpm typecheck && pnpm verify
```

`build` 必须排在 `typecheck` 前面：`extension-env.d.ts`（`chrome` 全局类型与 `*.css` 模块声明的来源）由构建生成且不入库。新 clone 后直接跑 `pnpm typecheck` 会报一堆 `Cannot find name 'chrome'`。

`pnpm verify` 里有一份期望的权限集（`tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`），并会主动拦截 Firefox 字段残留。**动权限就必须同时改它和 `docs/design.md` 的权限表**，两处不一致会被自检挡下来。

## 不要做的事

- 不要为了「顺手」把功能扩展到通用收藏管理（标签、笔记、全文检索）——那是另一个产品。
- **不要为 Firefox 做适配**。目标浏览器只有 Chrome；不加 gecko 目标、不加 `firefox:` 前缀字段、不做特征检测降级。
- 不要引入 UI 框架或状态管理库；两个界面都很小，纯 DOM 足够。
- 不要用 `chrome.tabs.query({})` 这类无过滤的全量查询，也不要读取标签页内容（不需要 `scripting` 权限）。
- 不要在 `shared/` 里搞 `globalThis.chrome` 的可空兼容层：Chrome 下 `chrome` 一定存在，直接用。
