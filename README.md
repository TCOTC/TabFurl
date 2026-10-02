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
- Node.js >= 22.12
- pnpm

## 常用命令

```bash
pnpm install

pnpm dev            # 开发模式（自动启动 Chrome 并加载扩展）

pnpm build          # 生产构建 → dist/chrome/

pnpm typecheck      # tsc --noEmit
pnpm verify         # 产物自检（需先 build）
pnpm icons          # 重新生成 src/images/ 下的占位图标
```

构建产物在 `dist/chrome/`，可在 `chrome://extensions` 用「加载已解压的扩展程序」加载。

## 文档

- [`docs/design.md`](docs/design.md) —— 需求范围、书签树数据模型、命名规则与初步方案
- [`AGENTS.md`](AGENTS.md) —— 面向 AI 协作者的工程约定

## 许可

MIT
