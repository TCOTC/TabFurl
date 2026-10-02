# TabFurl

把浏览器窗口的标签页**收进**书签文件夹，也能把书签文件夹**还原**成带标签分组的窗口。

`furl` 是「卷起帆」，`unfurl` 是「展开帆」——这个名字说的就是它的两个方向：

| 方向 | 做什么 |
| --- | --- |
| 窗口 → 书签 | 当前窗口的标签，按标签分组存成书签文件夹；每次保存产生一个带时间戳的会话文件夹 |
| 书签 → 窗口 | 打开某个存档文件夹，按它的子文件夹创建对应的标签分组 |
| 文件夹启动器 | 勾选多个存档文件夹，各自开一个阅读页标签页，方便并排浏览不同分类 |
| 存档管理 | 搜索、展开／折叠、重命名、删除存档 |

**保存前可以挑，也可以起名。** 主界面按窗口顺序列出当前窗口的标签（分组是带缩进的块，未分组的标签就地插在中间），
逐枚勾选要保留哪些再保存；整组也可以一键勾掉。
会话名是可选的：填了就是 `会议 · 2026-10-02 14:30`，留空则只有时间戳。
输入框下方实时显示「将存成」的名字（已含清洗与截断），所以预览就是最终写入书签的名字。

**还原前也可以挑。** 展开任一存档就能逐枚勾掉不想打开的标签；选好存档后三种打开方式：
「还原为窗口」「只开标签页」（不建标签分组）「打开阅读页」。

> 「当前窗口」指的是**主界面所在的那个窗口**（`chrome.tabs.query({currentWindow: true})`），
> 所以要在哪个窗口的位置上操作，就把主界面开在那个窗口里。

**只支持 Chrome（114+）**，不做 Firefox 兼容。Edge / Brave 等 Chromium 内核浏览器可直接加载同一个 `dist/chrome/`。

界面是一个独立标签页，顶部三个标签页切换（也可以用 `#capture` / `#archive` / `#settings` 直达）：

| 标签页 | 做什么 |
| --- | --- |
| 保存 | 给这次存档起个名字（可选），逐枚勾选要保留哪些标签，存进存档 |
| 存档 | 浏览与管理存档：搜索、展开、改名、删除；选中后批量打开 |
| 设置 | 存档位置、还原行为 |

## 为什么不用浏览器自带的收藏夹

自带收藏夹做不到两件事：

1. 不能**把当前窗口存成一套结构**——它只能逐个页面手动收藏，分组信息丢失。
2. 不能**为多个收藏文件夹同时开标签页**——只能在书签管理器里来回切换。

TabFurl 只补这两块，不做通用收藏管理：书签树仍然是唯一存储，浏览器自带的收藏夹同步、搜索、导入导出全都照旧可用。

## 环境要求

- Chrome 114 或更高（实际绑定 API 是 `chrome.tabGroups` 的 89，版本号保守取高）
- Node.js >= 22.12（构建）；跑单元测试需要 >= 23.6
- pnpm

## 常用命令

```bash
pnpm install

pnpm watch          # 监视 src/ 与 pages/，改完自动重建 dist/chrome/（日常开发用这个）
pnpm build          # 生产构建 → dist/chrome/（混淆）
pnpm dev            # 单次开发用构建 → dist/chrome/（不混淆，报错堆栈可读）

pnpm test           # 单元测试（node:test）
pnpm typecheck      # tsc --noEmit
pnpm verify         # 产物自检（需先 build）
pnpm icons          # 重新生成 src/images/ 下的占位图标
```

构建产物在 `dist/chrome/`，可在 `chrome://extensions` 用「加载已解压的扩展程序」加载。

注意 `pnpm build` 要排在 `pnpm typecheck` 之前：`chrome` 全局类型与 `*.css` 模块声明的来源 `extension-env.d.ts` 由构建生成、不入库，新 clone 后直接跑 `typecheck` 会报一堆 `Cannot find name 'chrome'`。

## 在 Chrome 里加载

1. `pnpm build`（开发时用 `pnpm watch`）生成 `dist/chrome/`
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选 `dist/chrome` 目录
4. 点工具栏的 TabFurl 图标 → 主界面在独立标签页打开（已开着则直接切过去）
5. 改完代码：`pnpm watch` 会自动重建，回到扩展页点卡片上的刷新（↻），再重开主界面标签页

首次还要在顶部「设置」标签页里指定存档位置：从下拉框里选一个**书签栏**下的文件夹。
扩展不会自己建文件夹，也不会往「其他书签」里写东西；列表里没有合适的就先在书签管理器里于「书签栏」下新建一个。

**关于自动编译**：`pnpm watch` 会监视 `src/` 与 `pages/`，改完自动重建 `dist/chrome/`。
它**不启动浏览器，也没有热重载**——重建完仍需自己点扩展卡片上的刷新（↻），因为自动重载
要依赖独立的 Chrome for Testing（约 150 MB，`pnpm exec extension install chrome`）。
好处是产物的权限与生产构建完全一致，`pnpm verify` 照常通过。

**关于 `pnpm dev`**：它只是「不混淆的构建」，**不启动浏览器、也没有热重载**（名字取短是为了顺手）。
真正的 `extension dev` 没有做成脚本——它需要先下载独立的 Chrome for Testing（约 150 MB，
`pnpm exec extension install chrome`），换来的是热重载与一套控制桥；本项目不做自动化验收，
所以换成了「手动加载 + 点卡片刷新」，省掉一个重依赖。需要时仍可临时 `pnpm exec extension dev`，
但它会把 `dist/chrome` 覆盖成开发版清单（多出 `scripting` 与 `management` 权限，
`pnpm verify` 会失败），跑完要再 `pnpm build`。

## 测试

`pnpm test` 用 Node 内置的 `node:test` 跑 `src/shared/*.test.ts`，不引入任何测试框架：

- Node 原生执行 TypeScript，`tools/ts-hooks.mjs` 负责给源码里无扩展名的相对导入补 `.ts`。
- `chrome.*` 靠给 `globalThis.chrome` 赋值来打桩，不需要给产品代码加依赖注入。
- 覆盖的是命名规则、URL 判定、占位卡片转义、还原计划、窗口采集、设置读写这些之前没有测过的核心逻辑。

需要真实 Chrome 才能确认的部分（`chrome.tabGroups` 的实际行为、主界面与文件夹页的布局、跨设备同步后书签 id 变化）仍需手工测。

## 文档

- [`docs/design.md`](docs/design.md) —— 需求范围、书签树数据模型、命名规则与初步方案
- [`AGENTS.md`](AGENTS.md) —— 面向 AI 协作者的工程约定

## 许可

MIT
