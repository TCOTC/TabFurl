# TabFurl

把浏览器窗口的标签页**收进**书签文件夹，也能把书签文件夹**还原**成带标签分组的窗口。

`furl` 是「卷起帆」，`unfurl` 是「展开帆」——这个名字说的就是它的两个方向：

| 方向 | 做什么 |
| --- | --- |
| 窗口 → 书签 | 当前窗口的全部标签，按标签分组存成书签文件夹；每次保存产生一个带时间戳的会话文件夹 |
| 书签 → 窗口 | 打开某个存档文件夹，按它的子文件夹创建对应的标签分组 |
| 文件夹启动器 | 勾选多个存档文件夹，各自开一个标签页，方便并排浏览不同分类 |

**只支持 Chrome（114+）**，不做 Firefox 兼容。Edge / Brave 等 Chromium 内核浏览器可直接加载同一个 `dist/chrome/`。

## 为什么不用浏览器自带的收藏夹

自带收藏夹做不到两件事：

1. 不能**把当前窗口存成一套结构**——它只能逐个页面手动收藏，分组信息丢失。
2. 不能**为多个收藏文件夹同时开标签页**——只能在书签管理器里来回切换。

TabFurl 只补这两块，不做通用收藏管理：书签树仍然是唯一存储，浏览器自带的收藏夹同步、搜索、导入导出全都照旧可用。

## 环境要求

- Chrome 114 或更高（扩展用到 `sidePanel`）
- Node.js >= 22.12（构建）；跑单元测试需要 >= 23.6
- pnpm

## 常用命令

```bash
pnpm install

pnpm dev            # 开发模式（自动启动 Chrome 并加载扩展）

pnpm build          # 生产构建 → dist/chrome/

pnpm test           # 单元测试（node:test）
pnpm typecheck      # tsc --noEmit
pnpm verify         # 产物自检（需先 build）
pnpm icons          # 重新生成 src/images/ 下的占位图标
```

构建产物在 `dist/chrome/`，可在 `chrome://extensions` 用「加载已解压的扩展程序」加载。

注意 `pnpm build` 要排在 `pnpm typecheck` 之前：`chrome` 全局类型与 `*.css` 模块声明的来源 `extension-env.d.ts` 由构建生成、不入库，新 clone 后直接跑 `typecheck` 会报一堆 `Cannot find name 'chrome'`。

## 在 Chrome 里加载

两条路，任选其一：

**A. 手动加载（推荐，用你自己的 Chrome、不用下载）**

1. `pnpm build` 生成 `dist/chrome/`
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选 `dist/chrome` 目录
4. 点工具栏的 TabFurl 图标 → 侧边栏打开
5. 改完代码：重新 `pnpm build`，回到扩展页点卡片上的刷新（↻），再重开侧边栏

**B. `pnpm dev`（热重载，但不用你的 Chrome）**

它启动的是独立的 **Chrome for Testing**，首次需要先下载：

```bash
pnpm exec extension install chrome   # 约 150 MB，装到 %LOCALAPPDATA%\extension.js\browsers\chrome
pnpm dev
```

优点是改文件即时生效、profile 存在 `dist/extension-profile-chrome` 里跨次保留；代价是一个干净的浏览器实例（没登录任何站点）。

⚠️ **`pnpm dev` 会把 `dist/chrome` 覆盖成开发版产物**（清单多出 `scripting` 与 `management` 权限，并写入 `extension-js-control.json`），此时 `pnpm verify` 必然失败。想拿到干净产物就再跑一次 `pnpm build`。

## 测试

`pnpm test` 用 Node 内置的 `node:test` 跑 `src/shared/*.test.ts`，不引入任何测试框架：

- Node 原生执行 TypeScript，`tools/ts-hooks.mjs` 负责给源码里无扩展名的相对导入补 `.ts`。
- `chrome.*` 靠给 `globalThis.chrome` 赋值来打桩，不需要给产品代码加依赖注入。
- 覆盖的是命名规则、URL 判定、占位卡片转义、还原计划、窗口采集、设置读写这些之前没有测过的核心逻辑。

需要真实 Chrome 才能确认的部分（`chrome.tabGroups` 的实际行为、侧边栏布局、跨设备同步后书签 id 变化）仍需手工测。

## 文档

- [`docs/design.md`](docs/design.md) —— 需求范围、书签树数据模型、命名规则与初步方案
- [`AGENTS.md`](AGENTS.md) —— 面向 AI 协作者的工程约定

## 许可

MIT
