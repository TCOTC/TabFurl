# AGENTS.md

AI 协作者的工程约定。**动手前先读 `docs/design.md`**（需求范围与数据模型的唯一来源）。

## 这个项目是什么

浏览器扩展：把窗口的标签页存成书签文件夹（`furl`），也能把书签文件夹还原成带标签分组的窗口（`unfurl`）。书签树是唯一存储，不引入自己的数据库。

## 技术栈与硬约束

| 项 | 值 |
| --- | --- |
| 目标浏览器 | **仅 Chrome**（未做 Firefox 兼容，不要加 gecko 目标） |
| 最低 Chrome | 114（实际绑定 API 是 `tabGroups` 89，不下调，见约定 3） |
| 构建工具 | `extension` **4.1.30**（精确版本，勿升级） |
| Node | >= 22.12（extension 4.x 要求）；`pnpm test` 需要 >= 23.6（原生 TypeScript 执行 + `module.registerHooks`） |
| 包管理器 | pnpm |
| 语言 | TypeScript，无 UI 框架，纯 DOM。`strict` + `noUnusedLocals` + `noUncheckedIndexedAccess`（见约定 10 最后一条） |
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

## 不可破坏的约定

1. **权限最小化**：无 `host_permissions`、无 content script。加功能先问「能不能不加权限」；要加 →
   `docs/design.md` 写理由 + 同步 `tools/verify-build.mjs` 的 `EXPECTED_PERMISSIONS`。
   `favicon` 是例外中的例外：只读 Chrome 本地 `_favicon` 缓存、**不联网**；已有 `tabs`，所以不多出权限警告。
2. **只用 `chrome.*`**：MV3 原生返回 Promise。不引 `browser.*`、不引 polyfill。
3. **`minimum_chrome_version: 114` 不下调**：下调 = 声明未验证的兼容性。用到更新 API 时同步抬高它 + `tools/verify-build.mjs` 的 `MIN_CHROME_VERSION`。
4. **命名规则只在 `shared/naming.ts`**：界面层不许自己拼字符串。规则见 `docs/design.md` 四。
5. **依赖方向单向，模块不互相 import**：`pages/` → `src/app/` → `src/shared/`；`shared/` 不许 import 界面模块。
   面板间只走 `dom.ts` 的 `AppEvents`；谁刷新、跳哪里由 `App.ts` 定。
   「别处的当前值」（如 chip 栏要知道这一栏站在哪）由 `App.ts` 递**取值函数**进去——
   那是查询不是事件，→ 不进 `AppEvents`。可直接 import 的工具模块只有三个：
   `BookmarkDialog.ts` / `FolderPicker.ts` / `icons.ts`。
   ⚠️ `FAVORITE_HOST_ID` 这类常量必须写在 `TEMPLATE` **之前**（模板求值时读它，放后面 TDZ 报错）；
   `TEMPLATE` 的 HTML 注释里**不能出现反引号**（会截断模板字面量）。
6. **`bookmarks` id 是设备本地的**：跨设备同步即变 → 不许当跨设备标识。
   唯一存进设置的 id 组 = `favoriteFolderIds`，且必须**可重建**——chip 栏刷新时剔掉读不出路径的 id，落点顺延到下一个可用收藏。
7. **写书签前先过滤内部页面**（`chrome://` / `chrome-extension://` / `devtools://` 等）→ `isInternalUrl()`。
8. **同名文件夹允许共存**：建之前不去重、不合并、不加 ` (2)` 序号（`dedupeName` 已删）。
   保存同样不去重：同一窗口存两次 = 真两份。代价是收藏夹出现同名文件夹，靠位置区分。
9. **样式**：颜色 / 字号 / 间距走 `base.css` 变量（`--space-*` / `--text-*`）；深色模式靠 `prefers-color-scheme`，不维护两套。
   一行条目（前置控件/图标 + 标题 + 副文案 + 尾部）用 `.item` / `.item__main` / `.item__title` / `.item__meta`，
   别在页面样式里重写 flex 与省略号——每重复一处就漏一次 `min-width: 0`（省略号失效）。
   两栏表头**必须等高**（`.col__head` 的 `min-height: var(--head-min)`）：差值会一直传下去，两栏的行从此不在同一水平线。
   盒子套盒子：外圆角 = `calc(内圆角 + 内边距)`。
10. **测试只用 `node:test`**：不引 vitest / jest / tsx。测试与实现同目录（`naming.test.ts`）；`chrome.*` 靠给 `globalThis.chrome` 赋值打桩，不给产品代码加注入。
    **取值用 `at()` 而不是 `!`**：`noUncheckedIndexedAccess` 下 `items[i]` 是 `T | undefined`——那是对的
       （越界真的可能），所以测试里用各文件自带的 `at(items, i)` 把「我认为这里有值」写成一条断言；
       `!` 会把错的假设吞掉。同一表达式里要两次取值时先存局部变量，否则判别式收窄不成立。
    **新代码别把 `let` 写成 `const` 或反之**：`let` 只给真会重新赋值的东西（全仓约 1:8）。
11. **保存 = 往「当前展示的那一层」追加，无会话层**：标签分组 → 子文件夹；未分组标签 → 就地在原位成散装书签，
    **不要**把它们收进「未分组」文件夹。
    写入唯一入口 `writeChildren(parentId, children)`（整窗保存与「拖一条标签过去」都走它）。
    ⚠️ **逆运算成对，改一处必须同步另一处**：`capture.ts` 的 `planWindowChildren()` ↔
    `restore.ts` 的 `planRestore()`（前者按 `TabSnapshot.index` 归并，后者按子级数组顺序还原）。
    规则见 `docs/design.md` 三、五。
12. **界面不许自己遍历标签 / 书签树**：勾选清单直接渲染 `planWindowChildren()` / `planRestore()` 的产物；
    枚数用 `countSnapshotTabs(selectTabs(...))` / `applyExclusions()`。
    自己走一遍树 → 顺序或过滤口径与写入/还原脱钩。
13. **收藏文件夹 = 书签（快捷方式），不是写入边界**：`Settings.favoriteFolderIds` **有序数组**，
    第一个可用的 = 打开界面时的落点（故 chip 支持拖拽排序）。
    只能收藏书签栏里的层（`getNodePath()` 第二项 === `getBookmarksBarId()`）；候选 **绝不退化为「其他书签」**；
    不自动建文件夹。三种拒绝原因给**三句不同的话**（根 / 不在书签栏 / 这层没了）——看着都像「按了没反应」。
    **一份状态两塊视图**：`createFavoriteStore` 唯一状态，`createFavoriteBar` 可实例化、两栏各一条；
    两条 `FolderPicker` 要 `idPrefix`（id 重复 → `aria-controls` 指错，界面上看不出来）。
    「跳过重建」的签名初值必须 `undefined`，**不能是空串**（空列表签名也是空串 → 第一次该画空态被当成「内容没变」）。
    跨栏搬东西 = `bookmarks.move`（移动非复制），**只有拖拽这一条路**：拖哪行搬哪行（文件夹行连子树）。
    跨栏**不要用 `canDropAt`**（查的是本栏父子索引）→ 用 `getNodePath()` 沿目标层父链挡「搬进自己子孙」。
    其余细节（输入法合成期间不过滤、下拉框钉右缘、chip 自有拖拽类型、左栏数据只在可见时读）见 `docs/design.md` 七。
14. **去向是按钮，建不建分组是复选框**：去向（当前窗口 / 新窗口）**不加回 `Settings`**；
    分组用 `#no-group-check` 表达，文案必须是「**打开**不建分组」（只写「不建分组」会被读成也管「存过去」）
    → 共两个按钮而非三个。
15. **两栏勾选集相反**：左栏**选中集**（`windowSelected`，默认空 = 全不选）；
    右栏**排除集 + 见过的书签 id**（`knownBookmarks`，没见过的算排除）。
    左栏不能用排除集（标签一直在变：新标签没被塞进去 → 默认变选中，集合追不上窗口）。
    右栏必须用排除集（列表随导航整层换掉，换层不该把这层勾选带过去）。
    **两侧都不许维护「另一份」集合**（过时的那份一旦并存 → 「列表看着全选、按钮说没选中」）。
16. **三态用原生 `indeterminate`，但点击意图自己推**：`indeterminate` 是 **DOM 属性**
    （写不进 `innerHTML`，建好元素再 JS 设）；原生 checkbox 本就有三态，不需要自定义控件。
    ⚠️ **不读点击后的原生结果**——它只把 `checked` 取反，于是「部分选择」变「全不选」，与惯例相反。
    一律走 `dom.ts` 的 `triState()` / `nextSelectAll()`：全选 → 全不选；部分 / 全不选 → 全选。
    三层（顶层 / 收藏夹文件夹 / 标签）同规则。
17. **叶子勾选框必须在渲染后手工同步**：`innerHTML` 写不出 `checked` → 叶子渲染出来一律未勾选。
    漏了 → 叶子永远显示未勾选，点一下反而变「勾上」（看着毫无反应）。容器（三态）同样要回填。
    **渲染函数的每条提前 return 都要走同步**（不只是 `updateButtons()`）：全选框文案与三态都在 `syncXxxStates()` 里，
    漏一条分支就**停在上一次的层**（实测：从满的层进空文件夹，右上角还写着「已选 0 / 234 个标签页」）。
18. **收藏夹侧副文案与左栏同一套读法**：`已选 K / N 个标签页` / `已全选 N 个标签页`；空层写「这一层没有可打开的标签页」。
    不写「尚未勾选（共 N 枚标签页），勾选后才能打开」那种说明（占半行只说一句「现在一个都没勾」）。
    也不把「还会还原的枚数」写成「N 个标签」。理由见 `docs/design.md` 七。
19. **两种组织记号都不是书签**：**分隔线**（`index.php`，竖线）与**间隔**（`index.php?t=horz`，通栏横线）。
    判定 `separatorKind()` / `isSeparatorUrl()`、名字 `SEPARATOR_LABELS`、网址 `separatorUrlOf()`、
    标题清洗 `separatorTitle()` 全在 `shared/urls.ts`。
    两者**不计枚数、无勾选框、还原跳过**，也不算 `skipped`。
    名字与外观成对（分隔线=竖线、间隔=横线）——两个新建按钮只差一个字，画一样就分不清在建哪个。
    行内第一个按钮 = 「转成另一种」（`data-swap-separator`）：**只改 `url`，不动标题**（标题是用户写的）。
    建完进改名态，标题可留空；有行内「修改 / 删除」（走与书签同一套处理器）；**也能拖**（位置本身有意义）。
    拖到左栏提示「这一条里没有可以打开的网址」。
    两条横线用**真实元素**（`.marker__rule`）**不是伪元素**（`::after` 永远排在子元素之后，没法把按钮放线右边）。
    竖线占一个与 `.favicon` **等宽**的槽位（`.marker__slot`）。
    ⚠️ 数标签必须走 `restorableBookmarks()`；判「是不是书签」必须用 `isRealBookmark()` / `realBookmarks()`
    ——**不能用「有没有 url」**（渲染要画笔记、计数与收集 id 要跳过它，两件事必须分开）。
    漏一处 → 「打开（N）」多算、全选框永远停在「部分选择」（总数里有永远勾不上的项）、文件夹副文案「N 个书签」偏大。
    文件夹行副文案 = 「N 个书签 • N 个文件夹」，**两个数字都只算直属子级**（勾选框只勾这层、
    `restoreFolder` 也只处理一层，三数同口径才对得上）。
    **不要改成递归到后代**：递归数字（例 312）跟着只能勾 18 条的勾选框 → 让人以为勾上会开 312 个。
    这是**语义选择**（递归实测 0.42ms，比读一次 `getSubTree` 还便宜），不是性能妥协。
    三个易被「顺手简化」的点：判定看**主机名 + 路径**（不是只认主机名）；
    `?t=` 只把 `horz` / `horizontal` 认作横向，其余（无参数 / `?t=vert` / 其他）一律算竖向；
    清洗要**首尾的横杠与空白一起去掉**（不是只剥横杠再 `trim()`）。
    真实数据（306 枚 `?t=horz` + 4 枚无查询串）：查询串必须忽略；标题是「教程────────────」这种**尾随**横杠（剥完是 `教程`）；零误伤零漏网。
20. **只允许一条滚动条，用满整页宽度**：`.app--shell` 锁一屏（`100dvh`），**不设宽度上限**。
    滚动交给两栏各自的 `.box`（`flex: 1; min-height: 0; overflow-y: auto`）→ 顶栏与底部按钮始终可见。
    **不给列表加 `max-height`**（会与页面滚动叠成两条滚动条）。
    两栏 `grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)`：**`0` 不能省**
    （默认 `1fr` = `minmax(auto, 1fr)`，下限是子项 min-content → 顶出横向滚动条）。`.col` 也写 `min-width: 0` 防御。
    `.box` 显式写 `overflow-x: hidden`（按规范，一轴非 `visible` 时另一轴算成 `auto`）。实测数字见 `docs/design.md` 八。
21. **撤销是内存态的**（无会话层）：靠 `writeChildren` 返回的 `SaveResult`（`folderIds` / `bookmarkIds`），
    **关掉界面即失效**。删除顺序**不能反：先删书签、再删文件夹**（反过来会连书签一起删掉、后面 id 全失效）；
    单个删除失败要吞掉，否则一次撤销被中间的失败卡住。
22. **拖拽是主要入口，不是锦上添花**。载荷用自有 `application/x-tabfurl` 区分「内部拖动」与「从网页拖来的链接」；
    `dragover` 里读不到 `data`（只有 `types`）→ 另用一个变量记住「正在拖什么」决定收不收。
    两栏**都收内部拖动**（栏内是挪、跳栏是存 / 开）；只挡「既非内部载荷、也没带网址」与「写不进书签树根的右栏」。
    | 拖动 | 落到哪 | 行为 |
    | --- | --- | --- |
    | 左栏标签/分组 | 左栏某一行 | `tabs.move` + 按落点所在行**归组或拆组** |
    | 左栏标签/分组 | 右栏 | `writeChildren` 存成书签 |
    | 右栏书签/文件夹/分隔线 | 右栏某一行 | `bookmarks.move`（同层排序），落文件夹行中间就进那一层 |
    | 右栏书签/文件夹/分隔线 | 左栏某一行 | 在那个位置 `tabs.create`；文件夹开成一组同名标签（分隔线无可开的网址） |
    | 从网页拖来的链接 | 右栏 | 按网址存成书签 |
    落点用**行内三分法**（`spotIn()`）：上缘 = 插前，下缘 = 插后，中间 = **进入**（只对文件夹行 / 分组行有意义）。
    ⚠️ **两个 move API 的 index 语义相反，写错就是差一格**：
    - `chrome.tabs.move`：index 是**移动之后**的位置 → 算插入位置先减掉「原本排在锚点前、要拖的那几枚」（`anchorInsertIndex()`）。
    - `chrome.bookmarks.move`：index 是**移动前**坐标系里的插入位置 → 锚点前传下标、之后传下标 + 1；省略 index = 追加末尾。
    插入提示用 `box-shadow`（`.is-drop-before` / `-after`）**不是伪元素**（分隔线那行已占 `::before` / `::after`）。
    **拖到自己那行要拒收、且不画提示**（`overOwnRow()`）：插自己前后落点都是原位——
    画线 = 承诺一件不会发生的事，还会报「已调整收藏夹顺序」而位置没动（**双重假话**）。
    所以 `dragover` 直接 `dropEffect = 'none'`（规范：none 时连 `drop` 都不派发），`drop` 里再兜一层。
    窗口栏标签行同理，但**只比「那一枚自己」不比整个分组**（组内别的位置是正当排序）。
    按钮只是拖拽的可点版本 → **两者必须共用同一条写入 / 打开路径**（`writeChildren` / `restoreFolder`）。
23. **点整行 = 点它的勾选框**（`toggleRowFromClick()`）：实现是**替用户点那个复选框**，而不是另写勾选逻辑
    （三态「全选 ↔ 全不选」的意图只在 `change` 处理器里写一次，再写一份必然分叉）。
    行上标 `data-row`（落在**包含**勾选框的那层），排除 `input, button, a`。
    收藏夹行内按钮同一套：书签行「打开 / 修改 / 删除」、文件夹行「进入 / 改名 / 删除」、分隔线「修改 / 删除」；
    复用同一批处理器（`data-open` / `data-rename` / `data-delete` / `data-confirm-delete`）与同一个 `renaming` / `pendingDeleteId`。
    四个细节不能删：
    - **书签「修改」走模态弹窗**（`BookmarkDialog.ts`）：有标题**与网址**两个字段，行内放不下。
      用原生 `<dialog>` + `showModal()`（Esc 关、焦点回归、背景惰化都是白送），**单例复用**
      （已开时先 `close()` 再 `showModal()`，否则连点报 `InvalidStateError`）。文件夹与分隔线只有标题 → 继续行内改名。
    - **「打开」先挡内部页面**（`isInternalUrl()`）：Chrome 不许扩展开 `chrome://`；这类书签真实存在（实测 `chrome://discards/`）。
    - **「打开」`active: true`**（点了就是要看）；拖到窗口里 `active: false`（那是「放进这批」）。
    - **改名时不显示「回车保存，Esc 取消」**（默认 Enter / Esc 行为已符合预期）。
24. **右栏子级只按书签树顺序渲染，不按类型拆两段**：分隔线靠 `grid-column: 1 / -1` 跨行，
    而用户放这些线就是为了隔开相邻的几组——一拆，线就跟着散装书签被推到列表末尾，位置一丢只剩装饰作用
    （早期自己渲染的「阅读页」就是这个毛病，实测书签栏根层 4 枚线全跑到末尾）。
25. **右栏是「可导航的浏览器 + 就地展开」两层并存**（Finder 的列表视图那套）：
    **双击子文件夹行（或点「进入」）= 进这一层**，退路就是面包屑（当前层之外都能点，包括某个收藏
    **之上**的那几层）；**点行首那枚方块 = 就地展开**，子级推开在下面、不换页。两者是两件事，不要合并。
    **没有「上一层」按钮**：一样东西两个入口，总有一个会先被人遗忘。当前的层存在 `viewFolderId`，
    它就是**写入目标**：「存过去」「新建文件夹」「＋ 分隔线」「＋ 间隔」「拖到右栏的空白处」都落在这一层。
    **展开不改写入目标、也不改任何计数**。**「全部展开 / 全部折叠」是一个按钮两档**，
    它必须配**虚拟滚动**才有意义（真实数据全展开是 11004 行，不虚拟化时一次 `innerHTML` 要 5 秒才出画面）。
    ⚠️ **改这一块之前先读 `docs/design.md` 七**：那里列着十几条**会静默失效**的约束
    （行高要从真实元素量、滚动时改名不重绘、滚动进视野要估算+实测、勾选框只给「会被打开」的行、
    行内展开后所有按 id 找节点都要走 `nodeIndex`、拖进自己子孙要真的拒收、导航要防双击的第二下…）——
    每一条错了都不报错，只是位置不对或点了没反应。
26. **右栏的列表框是两层的：`div.box` 装框架与滚动，`ul.list` 才是列表**。
    `renderArchive()` 每次都会重写 `ul.list` 的 `innerHTML`，所以**任何静态内容都必须放在 `.box__top` 里**
    （框内顶部的面包屑 + 按钮组，`position: sticky` 贴着框顶，滚到一半也不会消失）——
    写进那个 `ul` 的 HTML 里，第一次渲染就会被冲掉。左栏同样是 `div.box > ul.list`，两栏结构一致。
27. **两处「对齐」与四处「不抖动」都是算出来的，不是凑出来的**：
    - 列表**外面**的顶层全选框要与列表**里面**的勾选框对齐，差的是列表框那道描边 →
      `.select-all` 左边距 = `calc(var(--item-pad-x) + var(--border-width))`（不改就差 1px）。
    - 中间那列按钮等宽靠 `align-items: stretch` + grid `auto` 轨道取 max-content，宽度下限靠 `--move-btn-min`，缺一不可。
    - **会出现 / 消失的东西提前占位，不能用 `display: none`**：「撤销上次保存」用 `visibility: hidden`
      （`.is-slot-hidden`，不进布局也不接键盘焦点），底部状态行用 `min-height: 1lh`——
      否则一次操作后它们多出一行，把中间三个按钮上下推一下（实测 9px = 状态行高的一半）。
    - **`.box` 里所有「一排东西」都必须能换行**：`.box` 写着 `overflow-x: hidden`（理由见约定 20），
      所以内容宽过容器时**不会出现滚动条，也没有任何报错**——只是最右边的东西悄悄被裁掉。
      实测 820px 视口下右栏那个框只有 334px，而框顶那排按钮自带 351px：
      面包屑被挤成 0 宽（变成一列竖着的字），**`＋ 间隔` 整个点不到**。
      修法是两级 `flex-wrap`（`.box__bar` 与 `.box__bar > .row` 都要），而且按钮组必须是
      `flex: 0 1 auto`——写成 `flex: 0 0 auto`（不允许收缩）时内层 `flex-wrap` 形同虚设。
      同类风险：`.col__head` 的 chip 栏已按同一套处理（见约定 9）。**量的时候用 `evaluate` 比
      `scrollWidth` 与 `clientWidth`，别靠肉眼**——被裁掉的是最右边那个元素，截图里不一定看得见。
    - **「列相同内容」的渲染要能跳过重建**：不跳的话用户看到「字没变但闪一下」，悬停 / 焦点当场丢。
      已这么做：chip 栏与候选下拉框、右栏面包屑（`lastPathSignature`）、左栏标签清单（`windowSignatureOf()`）。
      **签名初值必须 `undefined`，不能是空串**（空列表签名也是空串 → 第一次该画空态被跳过）。
      **勾选不进签名**（由 `syncXxxStates()` 回填），但**行里画出来的东西一个都不能漏**：
      漏 `status` → 点「加载」后那行不变；漏 `pinned` → 固定后图钉要等别的变化才出现。
    - **签名用 `JSON.stringify` 拼，不要自己定分隔符**：手写分隔符隐含「内容里不会出现这个字符」这个错前提
      （实测用空格拼时 `[a, b, a b]` 与 `[a b, a, b]` 拼出同一个串，该重画的被「结构没变」跳过）。
      **代价是字段必须显式列出**——而这恰好是要的（整份快照会把 `lastAccessed` 也算上，而它每点一次标签就变）。
    - **不要往源码里放裸控制字符**：**ripgrep 见到 NUL 就把整个文件当二进制** → 它从搜索结果里**整个消失**
      （`git diff` 照样当文本），连**编辑工具也改不动**那一段。排查方法见 `docs/design.md` 八。
    - **局部的一步操作不要置灰按钮**：`busy` 只当防重入的闩（真花时间的操作——保存整窗、开几十个标签——才该置灰），
      置灰再恢复会让中间那排按钮闪一下。
    - **数据异步，所以列表先占位**：两个列表面板在模板里就放好 `.skeleton`，`renderXxx()` 一来冲掉它。
      **高度必须与真实行一致**（同一个 `--row-height`），否则数据到达时列表会「先短一截再变长」。
    - 按钮里的计数**不在括号里预留宽度**，而是给按钮 `min-width`（`--move-btn-min`）；
      括号用**半角并留一个空格**（`存过去 (3)`）——全角括号在中文字体里占满一格，看着空得发虚。
    - **`.favicon` 与 `.folder-tile` 尺寸必须一致**（都 26px、字形 19px）：两者同列交替出现，差 1px 标题左缘就错开。
      副文案显示**完整网址**而不是主机名（条目本来就靠网址区分同名页面），左栏标签行也是同一套。
    - **列表里所有行等高**：`--row-inner`（26px）+ `--item-pad-y` 算出 `--row-height`，
      `.item` 与 `.marker` 都写 `min-height` 用它，骨架占位也用它。两行文字（标题 + 副文案）**必须装得进 26px**
      （副文案行高写成 1.1 就会被撑到 39px）。
    - **新建文件夹默认名 = 本地时间戳**（`formatTimestamp()`），且建完 / 改名 / 新建记号之后都
      **把光标放到输入框最前面**（默认名就是给人改的，而 `focus()` 默认把插入点放末尾，正好反着）。
    - **行内改名的输入框高度必须 = `--row-inner`**（26px），**不是** `--row-height`：
      后者 38px = 「26px 内容 + 上下各 6px 内边距」，而输入框是**内容**的一部分——写 38px 时整行变 50px（实测），
      下面的行全部往下跳、退出又跳回来。同时要把 `.input` 的 `padding-top/bottom` 收掉，否则内容盒被压扁。
28. **页面里的标题块已去掉，名字在标签页标题上**：名称由 `document.title`（`App.ts`）与
    `pages/app.html` 的 `<title>` 两处给出——后者是为了脚本跑起来之前不闪一下文件名。
29. **不要自己再做一遍浏览器已经做好的事**：
    - 「看一层文件夹的全貌」曾是扩展自己渲染的**阅读页**（`pages/folder.html`），已删，改成「打开书签管理器」
      （`chrome://bookmarks/?id=<当前层>`）——那等于长期维护第二个界面，而浏览器做得更好。
      `chrome://` 能不能开由 Chrome 白名单决定，所以 `openInBookmarkManager()` 要 `try/catch` 并给一句**可操作**的提示（含 Ctrl+Shift+O）。
    - **打开书签管理器用 `?id=<数字 id>`**：管理器地址栏显示 UUID，但 `?id=` 认的就是 `chrome.bookmarks` 的数字 id
      （`router.ts` 的 `findIdByLegacyId()` 负责映射并改写地址栏）。曾在 Chrome 154.x 上碰见「传数字 id 静默退回默认层」，
      于是改成 `?q=<层名>`——后来查明那是**上游 bug**（Mojo 迁移回归，issue 565829425，修复已进 M155 与 154 之前的稳定线）。
      **下次再碰到「?id= 不生效」，先查上游 issue，不要先改设计**（依据见 `/memories/chromium-upstream-bugs.md`）。
    - **左栏行尾也有「关闭」，与右栏的「删除」同一套两步确认**：标签行关这一枚（`tabs.remove`），
      分组行则是**先解散、再关闭**（`tabs.ungroup` → `tabs.remove`，**顺序不能反**）：解散让分组因为
      「空了」而消失，连 Chrome 菜单里那份「已保存标签页群组」存档一起消掉；反过来先 `remove`
      只会得到「关闭群组」那个行为（存档保留）。2026-10-03 真实 Chrome 实测确认。
      分组那个按钮还要**按 groupId 问浏览器要名单**（`tabs.query({groupId})`）——界面那份把内部页面跳过了
      （它们存不成书签），而**关的时候跳过就错了**：分组只要还剩一枚标签就不会消失。
      两栏确认状态**分开两个变量**（`pendingClose` vs `pendingDeleteId`），主键用 `t<tabId>` / `g<下标>`；
      **`pendingClose` 必须进 `renderWindow()` 的签名**，否则换到确认态时那行不重画。
      关闭后**立刻 `refreshWindowOnly()`、不等去抖**（`onRemoved` 那条路要 120ms，那段时间里看着像「点了没反应」）。
    - 左栏每行末尾的「打开」也只是 `tabs.update({active: true})`，但**必须再 `windows.update({focused: true})`**：
      主界面与那一枚标签在不同浏览器窗口时，不聚焦窗口看着就是「点了没反应」。
    - **行尾那个位置是三档：加载 / 加载中 / 释放，判据全是 `Tab.status`**（卸载 / 正在加载 / 加载完）。
      用 `status` 而不是 `Tab.discarded`：两者在「卸载」这档等价，但 `status` 能把「正在加载」也表达出来，而界面恰好需要那档。
      「加载」只 `tabs.reload()`、「释放」只 `tabs.discard()`，**两者都不切过去**。
      **`tabs.onUpdated` 的过滤里必须有 `changeInfo.status`**，否则点完那行不变，看着像「点了没反应」
      （它只在卸载 / 开始 / 加载完时派发；Chrome 把它与 `discarded` 塞进同一个事件，两者永远同时到达）。
      **但「标题」什么时候到位不由扩展决定**：标题是页面自己给的，重 SPA 在标签不可见时往往走不到设置标题那一步，
      所以点过之后是「加载中」而不是按钮无声消失——状态要诚实。
      **活动标签不给「释放」**：它就在屏幕上，卸载它没意义。这不是 API 拒绝（`tabs.discard` 用的 EXTERNAL
      理由连活动标签都允许），是**我们自己的选择**，判据与 Chromium 自己的 discards 页同源。
      因此 `Tab.active` 也算「画出来的一部分」，**必须进签名**，`tabs.onActivated` 也要触发刷新。
      三档共用 `.btn--load`（定宽 `--load-btn-min`）：两个字与三个字不定宽就会在切档时差一个字宽。
    - **释放可能把 tab id 换掉，`tabs.onReplaced` 里必须把勾选搬过去**：`Tab.id` 会随 WebContents 被替换而变
      （Chrome 自己的测试里写着「the id changes after a tab is discarded」），而勾选正是按 tabId 存的
      ——不管的话勾选会在释放那一刻**静默丢掉**（`refreshWindowOnly()` 会剪掉不认识的 id）。
      **迁移必须在刷新之前**（刷新就会剪掉旧 id）。
30. **末尾落点画的是「最后一行下缘的一条线」，不是整栏高亮**：两栏都走 `markEndDrop(list, pane)`
    ——取该列表**所有** `[data-drop-row]`（含分组 / 文件夹内部的）的最后一行，只有列表真空才退化成整栏高亮。
    整栏高亮看着像「丢进这栏，具体到哪儿我不知道」，而写入其实总是**追加到末尾**，那条线说的才是真话。
    **不能用 `:last-of-type` 找最后一行**：它按元素类型（`li`）算，而左栏最后一行的父级是分组里的 `ul`，
    匹配不到就掉回「整栏高亮」那条错路。
31. **图标只有一份，放在 `src/app/icons.ts`**：同一图形（加号、文件夹、竖线）不许在两个模块里各写一遍。
    两处要不同尺寸时**传 class**（`plusIcon('move__icon')`），不要复制一份改描边（同一个加号在两处粗细不同，看着像两个人画的）。
    **SVG 的 `stroke-width` 是 viewBox 单位，不是像素**：`viewBox="0 0 16 16"` 画在 26px 槽位里，
    屏幕粗细 = `stroke-width × 26 / 16`（调粗细先按这个比换算，否则会在「明显粗」与「几乎看不见」之间来回改）。
    **只有图标的按钮用 `.btn--icon`**（方形定值 24px，不靠内边距撑）；它没有可读文字，
    所以 `title` / `aria-label` **必须**写——否则读屏与悬停都拿不到含义。
32. **左栏由标签事件驱动刷新，不只靠「我们的动作自己调 refresh」**：`chrome.tabs` 的
    `onCreated` / `onRemoved` / `onMoved` / `onUpdated`（只挑 `title` / `url` / `groupId` / `pinned`）
    与 `tabGroups.onUpdated` 都接到 `scheduleWindowRefresh()`（去抖 120ms → `refreshWindowOnly()`）。
    教训具体：从收藏夹拖一条到左栏，新建的标签**刚出现时 `url` 可能还没提交**，而 `isInternalUrl('')` 会把它当内部页面滤掉，
    于是它在那轮列表里缺席，下次刷新要等用户再点别的东西（看到的正是「开新标签后窗口列表没自动更新」）。
    **`refreshWindowOnly()` 只重读窗口**（不动收藏夹与设置）。
    **两栏各一个手动刷新按钮**（`.btn--icon`），都挂在**各自全选框那一行的右端**，两栏对称；
    它们**不置灰**（正因为「界面看着不对」才点它），都走同一条 `refresh()`——不为某栏另写一条「只重读书签树」的路（多一条多一处分叉）。
    两条实现约束：**按钮必须在全选框建好之后再 append**（`createSelectAll()` 也往同一行 append，
    而按钮靠贴右推到行尾——先插按钮会把后面的全选框挤走）；**贴右的多个东西要包成一组**
    （`.row--push-end`，只留最外层一个 `auto`）——flex 会把剩余空间在多个 `auto` 之间**平分**
    （实测两个按钮各自被推到一半、相距 216px）。左栏那个钉在那行**右端**（跟在文字后面会随文字长度左右滑）。
33. **F7：左栏可以切成收藏夹，两栏之间能互相搬**。左栏看什么由一个 `Mode`（`'window' | 'archive'`）决定，
    **不落盘**（与展开状态同理：它是浏览过程中的视图状态，打开界面永远是「窗口 ⇄ 收藏夹」那副样子）。
    入口是左栏表头那一枚**两档分段控件**（`.modes` > `.mode`），它顶掉原来的 `<h2>`：改的就是这一栏装什么，
    摆在别处都要用户先建立一次「这点的是左边」的心智映射；而右栏同一位置放的是 chip 栏，于是两栏表头对称。
    计数是**两档共用的一枚胸章**（`#left-count`，在 `.modes` **外面**）：它说的是「左栏现在有几条」，
    而那是同一件事的数（两个档各背一枚时，总有一枚在说另一个档的事）。它由**面板**按当前这一档写，
    所以 `ArchivePane` 的胸章元素是**可选**的（左栏那个实例不给），而它的 `count()` 供面板取数。
    **`archiveColumnMarkup` 生成的标记里不许出现反引号**（模板字面量，会截断它）。
    - **收藏夹那一栏的标记由 `archiveColumnMarkup(prefix)` 生成两份**，两个 `ArchivePane` 实例靠
      **id 前缀**分开（`archive` / `left-archive`）：它们住在同一份 DOM 里，id 重了就会各自找到对方的
      东西，而那种错很安静（一边勾选、另一边跟着变）。左栏那个实例的 `root` 用**整栏**而不是那个视图
      （表头里的东西不在视图里）；胸章那一格**整栏共用一个**，由面板按当前这一档写。
    - **中间那一列整列收起**（`#mid` 用 `hidden`，同时把 `.split` 换成 `.split--archive` 把网格轨道
      从三条收到两条——不收的话中间那个空轨道还会吃掉一格 `gap`）：窗口语义的五个控件
      （存过去 / 打开 / 新窗口 / 不建分组 / 撤销）在这一档下一个都不成立，而那一列也没有别的东西可放。
    - **两栏都不给勾选框**（`ArchivePane.setSelectable()`）：这一档全靠拖拽，勾选框在那里只会让人
      以为「先勾上、再点中间的按钮」——而中间那一列已经不在了。全选框那一行也跟着收起来，
      只剩右端那几枚按钮。注意**「不给勾选框」与「没有勾选框」不一样**（见 `boxSlot()`）：
      同一份清单里只有**部分**行没有勾选框时（分隔线、展开出来的深层行）要用 `.marker__slot`
      等宽占位（与复选框实测都是 14px，不给就会整列左移一格）；而整栏都不要勾选框时**什么都不给**。
    - **`[hidden]` 要显式写出来**（`.left-view[hidden]` / `.mid__archive[hidden]`）：`[hidden]` 是浏览器
      默认样式表里的 `display: none`，而作者样式优先级更高——不补这一句，两块会同时显示、上下摞在一起。
    - 拖拽按**落在哪一栏**路由（`archivePaneAt()`），而不是靠 id 前缀去猜；`change` 事件按**输入框在哪一栏**
      分发（不要写成「先问一个、不是再问另一个」：`data-archive-item` 两栏都有，第一个实例会把它当成自己的）。
      起点那一栏要在 `dragstart` 时记下来（`draggingPane`）：**两栏停在同一层时两边认得的是同一批 id**，
      光看载荷里的 id 分不出它来自哪一边。
    - **两个实例共用一个 `flags {busy}`**：「正在写入」是全局的一件事，保存到一半不该能删书签。
    - 两栏的落点**各自独立**（`viewFolderId` / `expandedIds` / 勾选集都是每实例一份）。
    - **多选只在没有勾选框那一档启用**（`setSelectable()` 同时开关两者）：同一行上两个「选中」会让「选了几条」有两种说法
      → **多选与勾选永不共存**。
      Ctrl / Cmd 点 = 切换这一条，Shift 点 = 从起点到这一条**按可见顺序**全选（展开出来的子级也在范围里），
      **普通点击不改选择**（只把 Shift 起点挪过来），点空白 = 清空。普通点击不选是有意的：随手点一下就把刚选好的一批清掉太容易发生。
      **Shift 不挪起点**（`pickAnchor`）：连按几次可以反复调范围。
      **取消选中**两个入口：点空白 / 框内顶部的「取消选中」按钮（只在真选中了东西时露面；
      没有时用 `is-slot-hidden` 藏起来**而不是 `display: none`**——一出现就把右边四个按钮整体往右顶）。
      那句可见性写在 `renderArchive()` 的**开头**：那个函数有好几条提前 return，漏哪一条都会让按钮从「选中了一批」的层走到空层时还留着）。
      存的是**用户点过的 id**，用之前先过 `topLevelPicked()` 规约成顶层项（绘制与拖拽都要它，不然同一个文件夹会被画两次 / 搬两次）。
    - **高亮框一段一段地拼，不摆绝对定位的框**（`renderArchiveWindow` 里按 `inBoxAt()` 拼 class）：
      行等高且扁平，逐行拼视觉上等价，而**虚拟滚动下不用关心视口裁剪**。
      「在框里」是布尔量（自己或某祖先被选中）→ 选中展开的文件夹 = 一个框包住整棵子树；再单点里面一条 → **不会多出嵌套的框**。
      段首段尾靠**比邻居**判（邻居在视口外也算得出）→ 相邻几条选中会连成**一个**框。
      用 `box-shadow` 不用 `border`，因为后者会把行撑高（行高是算出来的定值）。
    - **批量拖动载荷 = `{kind: 'selection', ids}`**（`dragIdsOf()` 在起点判定），搬的时候**一律追加到目标层末尾**：
      一批一起精确插入的语义很绕（相对顺序、同父下移时 index 要先减一…），而用户拖一批过来说的是「搬到那一层」。
      所以落点只用来解出**哪一层**（`destOf()`）。三条留在原地的情况照旧要说出来：已在那一层的、要搬进它自己里面的、一条都搬不动时。
    - **两处「静默失效」的教训，都是 F7 引入的**（不报错，只是看着不对）：
      ① **CSS 里不按 id 选两栏共用的东西**：`--depth` 缩进与 `.vpad` 原本写 `#archive-list > li`，参数化后左栏那个叫 `#left-archive-list`
         → **左栏的行全都不缩进**。形状类规则一律挂 class。
      ② **「进入这一格」的圈不能只写 `.group`**：那是窗口栏标签分组行的 class，而收藏夹文件夹行是 `item group__head`，**不匹配**
         → 拖到文件夹上什么都不显示。两个都要有（`.group.is-drop-active, [data-enter-folder].is-drop-active`）。

## 验证拖拽时不要看 `dropEffect`

**合成事件里的 `DataTransfer.dropEffect` 读回来永远是 `'none'`**（它由浏览器在真实拖拽会话里管理，而 `new DragEvent(...)` 没有会话）
→ 这个读数**没有任何区分力**。要验「这个落点收不收」，看这三样（都有区分力）：
**DOM 里的提示标记**（`.is-drop-*` 数量）、**`event.defaultPrevented`**（拒收的分支是提前 `return`）、**`__calls` 里有没有真的 `move`**。
用法与其余测量纪律见 `tools/preview/README.md`。

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
- 不引 UI 框架或状态管理库；两个界面都很小，纯 DOM 够用。
- 不用 `chrome.tabs.query({})` 这类无过滤全量查询，也不读标签页内容（不需要 `scripting`）。
- 不在 `shared/` 里搞 `globalThis.chrome` 可空兼容层：Chrome 下 `chrome` 一定存在。
