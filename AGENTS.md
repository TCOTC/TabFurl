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
浏览器里报错时的堆栈是真实函数名。

⚠️ **`watch` / `dev` 只构建，不启动浏览器、也没有热重载。** 重建后仍需自己去 `chrome://extensions`
点扩展卡片上的刷新（↻）再重开主界面标签页。

**不要给 `extension dev` / `start` / `preview` 加脚本**：它们要求先下载独立的 Chrome for Testing（约 150 MB），
而且**必然产出开发版清单**（多出 `scripting` / `management` 权限，`pnpm verify` 必失败）。
这就是 `tools/watch.mjs` 自己调 `extension build` 的原因；`extension build` 本身没有 `--watch`，
所以监视能力由 `fs.watch` 补。完整论证与实测细节（含「临时跑完 dev 要再 build 一次」）见 `docs/design.md` 十。

## 目录结构

只有三条容易踩错，其余（完整清单与各文件职责）见 `docs/design.md` 七：

- `src/manifest.json` 是清单来源，**不要**挪到 `public/`（构建会直接失败）。
- `pages/` 是构建工具的**特殊目录**（放「未被清单声明的 HTML」）；把主界面挪回 `src/` 就不会产出。
- `extension-env.d.ts` 由构建生成且已 gitignore，**不要手写、不要提交**。

## 不可破坏的约定

1. **权限最小化**：当前不需要任何 `host_permissions`，也没有 content script。加功能时先问「能不能不加权限」，新增权限必须在 `docs/design.md` 里写理由，并同步 `tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`。
   现有权限里 `favicon` 是例外中的例外：它**只读 Chrome 本地缓存、不联网**（`_favicon` 端点），而且因为已经有 `tabs`，它不会多出权限警告。
2. **只用 `chrome.*`**：MV3 下这些 API 原生返回 Promise，不再需要 `webextension-polyfill`。不要为了「保持中立」而引入 `browser.*` 或 polyfill。
3. **`minimum_chrome_version: 114` 是保守下限，不要下调**：本项目实际用到的最高 API 要求是 `chrome.tabGroups`（89），移除 `sidePanel` 后 114 已无强制理由，但下调等于声明未经验证的旧版本兼容性。若将来用到更新的 API，必须同步抬高此版本号，并同步 `tools/verify-build.mjs` 的 `MIN_CHROME_VERSION`。
4. **命名规则只在 `shared/naming.ts` 里实现**：界面层不得自己拼字符串。规则见 `docs/design.md`。
5. **依赖方向单向，模块之间不互相 import**：`pages/` → `src/app/` → `src/shared/`。`shared/` 不得 import 任何界面模块；
   `src/app/` 里只有 `TransferPanel` 一个界面模块，它不 import `DefaultFolderPicker`，两者只通过 `dom.ts` 的 `AppEvents` 通信（谁该刷新由 `App.ts` 决定）。
   `DefaultFolderPicker` 不是面板：它不读 `AppEvents`，而是**触发** `settingsChanged`（选中即落盘），由 `App.ts` 挂在工具栏。
6. **`bookmarks` API 的 id 是设备本地的**：同一账号在另一台设备上 id 不同。任何持久化数据都不要以书签 id 作为跨设备稳定的标识；id 只允许存在本地设置里（现在只有 `defaultFolderId`），且必须能重建。
7. **写入书签前先过滤内部页面**（`chrome://`、`chrome-extension://`、`devtools://` 等），用 `isInternalUrl()`。
8. **同名文件夹允许共存**：建文件夹**前不要**去重、不要合并、也不要追加 ` (2)` 序号（`dedupeName` 已删）。
   书签树本就允许同级同名，而且用户在不同窗口里可能真的有两个叫「工作」的分组。代价是收藏夹里会出现多个同名文件夹，靠位置区分。
   同理，**保存不做去重**：同一个窗口存两次就是真的两份。
9. **样式**：颜色、字号、间距一律走 `base.css` 的变量（`--space-1..6`、`--text-xs/sm/md/lg`），不写死数值；深色模式靠 `prefers-color-scheme`，不单独维护两套。
   一行条目（前置控件/图标 + 标题 + 副文案 + 尾部说明）用 `base.css` 的 `.item` / `.item__main` / `.item__title` / `.item__meta`，
   别在页面样式里重写一遍 flex 与省略号——那种重复每多一处就会漏掉一次 `min-width: 0`（省略号就失效了）。
   **盒子套盒子时，外圆角 = 内圆角 + 内边距**（写成 `calc(内圆角 + 内边距)`，别各写一个值）：差值不对，内块的四个角就会顶到外框的弧线上。
10. **测试只用 `node:test`**：不引入 vitest / jest / tsx 等框架。测试文件与实现同目录（`naming.test.ts`），`chrome.*` 靠给 `globalThis.chrome` 赋值来打桩，不给产品代码加依赖注入。
11. **每一次保存都是往「当前展示的那一层」里追加，没有会话层**：标签分组建子文件夹，未分组的标签建成散装书签就地在原位，**不要**把它们收进「未分组」文件夹。
    两个实现是逆运算，改一处必须同步另一处：`capture.ts` 的 `planWindowChildren()` ↔ `restore.ts` 的 `planRestore()`
    （前者按 `TabSnapshot.index` 归并，后者按子级数组顺序还原）。规则与理由见 `docs/design.md` 三、五。
    写入只有一个入口：`writeChildren(parentId, children)`，整窗保存与「拖一条标签过去」都走它。
12. **界面不得自己遍历标签／书签树**：勾选清单直接用 `planWindowChildren()` / `planRestore()` 的产物渲染，
    「将保存／将还原 N 个」也由 `countSnapshotTabs(selectTabs(...))` / `applyExclusions()` 算。
    一旦界面自己走一遍树，顺序或过滤口径就会与写入/还原脱钩——这是第 11 条那一对函数新增消费方时最容易出的错。
13. **默认展示文件夹由用户在书签栏里指定，扩展不建根文件夹**：候选**只**来自 `getBookmarksBarId()`（认 id `1`，认不出就报错），
    **绝不退化为「其他书签」**，也不要加「自动创建文件夹」这类行为。
    它由 `src/app/DefaultFolderPicker.ts` 提供（`listDefaultFolderCandidates()`），**挂在工具栏（不在任何一栏里）**，选中即落盘。理由见 `docs/design.md` 三。
14. **还原去向是按钮，不是存起来的偏好**：**不要把它加回 `Settings`**，也不要为了省一个按钮而合并它们。
    「只开标签页」固定开新窗口：它与「还原到新窗口」是同一件事的轻重两档，都不打断正在用的窗口。
    阅读页（`pages/folder.ts`）同样给出这两个按钮。理由见 `docs/design.md` 五。
15. **勾选用「排除集」而不是「选中集」**：默认什么都不排除，界面上才不会在每次重渲染后把用户没碰过的项弄丢。标签用 `TabSnapshot.tabId`（标签存活期间不变），书签用书签 id；**不要用 `TabSnapshot.index`**，它会被别的标签关闭而整体前移。
    两侧的**默认值相反，是刻意的**：保存侧默认全选（语义就是「把当前窗口收起来」）；收藏夹侧默认一个都不勾（还原是「要打开哪些」，默认全开太危险，而且刚存完的不该被下一次还原顺手打开）。
    收藏夹侧的「默认不勾」仍用排除集实现：多维护一份「见过的书签 id」（`knownBookmarks`），没见过的默认算排除。
    换成选中集就不能两头都对——所以别改。
16. **三态勾选框用原生 `indeterminate`，但点击意图要自己推**：
    `indeterminate` 是 **DOM 属性**（写不进 `innerHTML`，必须建好元素再用 JS 设），所以原生 checkbox 本来就支持三态，不需要自定义控件。
    但点击时**不要读原生结果**——原生只是把 `checked` 取反，于是「部分选择」（`checked` 为真）会变成「全不选」，与惯例相反。
    用 `dom.ts` 的 `triState()` / `nextSelectAll()` 推：全选 → 全不选，部分与全不选 → 全选。三层（顶层、收藏夹文件夹、标签）用同一套规则。
17. **叶子勾选框的状态必须在渲染后手工同步**：`innerHTML` 写不出 `checked`，所以叶子渲染出来一律是未勾选。
    若忘了在 `applyContainerStates()` / `syncStates()` 里按模型回填，症状是**叶子永远显示未勾选**，
    而点一下反而把「未排除」改成「勾上」——看上去完全没反应。容器（三态）也必须回填，否则它会与实际状态脱钩。
18. **勾选只有一个维度**：不要再维护一份「哪些项被选中」——它与第 15 条的排除集一旦并存，就会出现「列表看着全选、按钮说没选中」。
19. **收藏夹侧的副文案以「已选」为主**：不能把「还会还原的枚数」写成「N 个标签」——默认不勾时会显示成「0 个标签」，看着像这一层是空的。
    用 `尚未勾选（这一层共 N 枚标签页）` / `已选 K / N 枚标签页`。说「这一层」而不是「收藏夹里」：
    勾选跟着右栏展示的层走，`打开（N）` 也只算那一层。理由见 `docs/design.md` 七。
20. **分隔线是记号，不是书签**：判定 `isSeparatorUrl()` 与标题清洗 `separatorTitle()` 都在 `shared/urls.ts`，两处界面都把它画成一条横线，
    **不计入任何枚数、没有勾选框、还原时跳过**，也不算 `skipped`。
    **新增任何「数标签」的地方都必须走 `restorableBookmarks()`**，否则枚数会在分隔线上对不上。
    书签树那一侧同理：**判断「是不是书签」必须用 `isRealBookmark()` / `realBookmarks()`（`shared/bookmarks.ts`），不能用「有没有 url」**。
    这两件事必须分开：渲染要画分隔线，计数与收集 id 要跳过它——用同一个写法就只能对一头。
    漏了一处的症状：右栏「打开（N）」多算、全选框永远停在「部分选择」（总数里有永远勾不上的项）、文件夹副文案的「N 个书签」偏大。
    两个最容易被「顺手简化」掉的细节：判定要看**主机名 + 路径**（不是只认主机名）；清洗要把**首尾的横杠与空白一起去掉**（不是只剥横杠再 `trim()`）。
    真实书签数据的三条实测（306 枚 `index.php?t=horz` + 4 枚 `index.php`）：查询串必须忽略；
    标题是「教程────────────」这种**尾随**横杠（剥完是 `教程`）；判定与标题清洗零误伤、零漏网。
21. **主界面只允许有一条滚动条，而且用满整页宽度**：`.app--shell` 把整页锁在一屏内（`100dvh`）、**并且 `max-width: none`**（`.app` 那个 `--content-max` 只留给阅读页）。
    滚动交给两栏各自的 `.box`（`flex: 1; min-height: 0; overflow-y: auto`），这样顶栏与底部按钮始终可见。
    **不要给列表加 `max-height`**——那会与页面滚动叠成两条滚动条。
    两栏是 `grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)`：**`0` 不能省**。默认的 `1fr` 等于 `minmax(auto, 1fr)`，
    那个 `auto` 下限就是子项的 min-content（一列不换行的标题 → 最长那条标题的宽度，实测 422px / 364px），
    两栏加起来超过窗口时整页就会多出一条横向滚动条。`.col` 上也同步写 `min-width: 0` 做防御。
    `.box` 另外显式写 `overflow-x: hidden`：`overflow-y: auto` 会把另一个轴按规范计算成 `auto`，
    于是列表里溢出一点点就冒出横向滚动条（而且竖向滚动条一出现、内容宽度又变小，两者容易互相激发）。
    阅读页（`folder.html`）不加 `app--shell`：它就是要整页往下读的文档。
22. **没有会话层，所以撤销是内存态的**：每次保存只是往当前层追加，没有一个「刚建的那棵子树」可删。
    撤销靠 `writeChildren` 返回的 `SaveResult`（新建的 `folderIds` / `bookmarkIds`），**只存在内存里，关掉界面就失效**。
    删除顺序不能反：**先删书签、再删文件夹**（反过来会连书签一起删掉，让后面的 id 全部失效）；
    单个删除失败要吞掉，否则一次撤销会被中间的失败卡住。
23. **拖拽是本项目的主要入口之一，不要把它当成可选的锦上添花**：左栏的标签/分组可拖到右栏保存（落在文件夹行上就进那一层），
    右栏的书签/文件夹可拖到左栏打开。载荷用自有的 `application/x-tabfurl` 区分「内部拖动」与「从网页拖来的链接」；
    `dragover` 里读不到 `data`（只有 `types`），所以另用一个变量记住「正在拖什么」来决定收不收。
    按钮只是拖拽的可点版本，**两者必须共用同一条写入/打开路径**（`writeChildren` / `restoreFolder`），否则口径会分叉。
24. **阅读页的子级只能有一个网格，顺序即书签树顺序**：文件夹卡片、书签卡片、分隔线三类子级共处一个 `.grid`，
    分隔线靠 `grid-column: 1 / -1` 横跨整行。**不要按类型拆成「子文件夹」「未归入子文件夹」两段渲染**——
    一拆，分隔线就跟着散装书签被推到列表末尾，而用户放这些线就是为了把相邻的几组文件夹隔开
    （实测：书签栏根层 4 枚线全跑到末尾，位置一丢，线就只剩装饰作用）。
    代价是节标题没了，概览靠顶部的「N 个子文件夹 · N 个书签」一行。
    主界面右栏**已经**是保序的（`archiveChildren` 与文件夹内的 `.kids` 都按数组顺序渲染），别把它也拆成两段。
25. **右栏是可导航的浏览器，不是可展开的树**：双击子文件夹行（或点「进入」）进入那一层，
    `↑ 上一层` 与面包屑退出来。当前的层存在 `viewFolderId`，它就是**写入目标**：
    「存过去」「新建文件夹」「拖到右栏的空白处」都落在这一层。
    **不要改回「全部展开 / 全部折叠 + 缩进链」**：层级一深，缩进链会把面板压成一条细缝，而「上一层」是 O(1) 的退路。
    工具栏那个选择器叫**「默认展示文件夹」**（设置字段 `defaultFolderId`），它是**起点不是边界**：
    右栏可以走到它**上面**的层（实测在「工具」时面包屑的 `书签` 与 `书签栏` 都可点）。
    所以**没有「存档根」这个概念了**，`parentFolderId()` 就是路径上的上一层，面包屑除当前层外全部可点。
    三个必须保留的细节：
    - **导航要防双击的第二下**。双击是两次独立的 `click`，而第一次跳转就重绘了 DOM，
      第二次 `click` 打到的是**新的一层**，于是「双击进入」会变成「一下进去两层」。
      所以 `navigateTo()` 里有一个 350ms 的守卫（`NAVIGATION_GUARD_MS`），别当成多余的代码删了。
      同理，`dblclick` 处理器要把 `input, button` 排除在外，否则双击「删除」会顺手进去一层。
    - **视图在刷新时能留在原地就留在原地**（用户在浏览收藏夹，不该因为一次刷新被弹回起点）；
      只有那一层真的没了（`getNodePath` 返回空）才回到默认展示文件夹。默认文件夹本身也没了时要**清空 id**，
      否则会把它当成「有效但空的文件夹」渲染出一句错误的空态文案。
    - **书签树的根是唯一不能写入的层**（`canWrite()` = 路径长度 > 1）。Chrome 不接受在根下面直接建书签，
      所以那里「存过去」「新建文件夹」禁用、拖拽不收，并用一行 `#archive-note` 说明原因与退路——
      两个灰按钮不加解释看起来就是「到了这里啥也干不了」。到那一层时面包屑自然没有可点的项（它上面没东西）。
26. **右栏的列表框是两层的：`div.box` 装框架与滚动，`ul.list` 才是列表**。
    `renderArchive()` 每次都会重写 `ul.list` 的 `innerHTML`，所以**任何静态内容都必须放在 `.box__top` 里**
    （框内顶部的面包屑 + 导航按钮，`position: sticky` 贴着框顶，滚到一半也不会消失）。
    把静态内容直接写进那个 `ul` 的 HTML 里，第一次渲染就会被冲掉。
    左栏同样是 `div.box > ul.list`，两栏结构一致（`.box` 的规则才不用分叉）。
27. **两处「对齐」都是算出来的，不是凑出来的**：
    - 列表**外面**的顶层全选框要与列表**里面**的勾选框对齐，差的是列表框那一道描边。
      所以 `--item-pad-x`（行内边距）与 `--border-width`（描边宽）都在 `base.css` 里定义，
      `.select-all` 的左边距写 `calc(var(--item-pad-x) + var(--border-width))`。
      实测不改就是差 1px（24 vs 25）——肉眼刚好能看出「没对齐」。
    - 中间那列几个按钮等宽靠 `align-items: stretch` + grid 的 `auto` 轨道取 max-content，
      **不要写死 `min-width`**：改文案就会跑偏。

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
