# 预览桩（tools/preview）

把 `dist/chrome` 当静态网站跑起来，注入一个 `chrome.*` 内存桩，就能在浏览器里驱动**真实的界面代码**
并做断言。

**为什么需要它**：`src/app/` 那三千多行没有任何单元测试（110 个测试全在 `src/shared/` 的纯函数上）。
这里是它们唯一的自动验证手段——重构那两个巨型闭包时，靠的就是它。

## 跑起来

```bash
pnpm build                      # 必须先是干净产物
pnpm preview:serve              # = node tools/preview/serve.mjs
```

然后在浏览器工具里注入桩，**注入必须在 `goto` 之前**：

```js
// 桩由预览服务器发出（`/__stub.js`），所以这里不需要任何本地路径。
// 为什么不用 `addInitScript({path})`：它以 **Playwright 自己的 cwd** 解析相对路径（在 VS Code 里那是
// VS Code 的安装目录，不是仓库根），所以 `{path}` 只能写死一条本机绝对路径——那种路径不该进仓库，
// 换台机器就断。
await page.addInitScript({content: `
  const r = new XMLHttpRequest()
  r.open('GET', '/__stub.js', false)
  r.send()
  ;(0, eval)(r.responseText)
`})
await page.goto('http://localhost:8788/pages/app.html?v=' + Date.now())
await page.waitForSelector('#window-list li')
```

同步 XHR 是必需的，不是保守：`addInitScript` 的内容在**页面自己的脚本之前**执行，那时还没有可用的
异步等待链，而桩必须先把 `window.chrome` 立起来（`stub.js` 自己读书签树用的是同一个办法）。

⚠️ **`addInitScript` 是累积的，而且后注册的覆盖先注册的**（桩用
`Object.defineProperty(window, 'chrome', {...})`，所以覆盖有效）。
后果是**改了桩却看不出变化**：旧的那一份还在同一页上生效。改完桩要么重开一个页面，
要么记住这一点再排查。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--root` | `dist/chrome` | 产物目录 |
| `--port` | `8788` | 监听端口 |
| `--tree` | `sample-tree.mjs` 的合成树 | 换成真实导出（`chrome.bookmarks.getTree()` 的 JSON），压大数据用；路径由调用方给 |

## 桩给了什么

- `window.__tabs`：左栏看到的标签。一个分组三枚，其中一枚是**浏览器内部页面**（`chrome://newtab`，
  界面会过滤掉它）；另有 `status: 'unloaded'` 的一枚与活动标签一枚。
- `window.__calls`：`{bookmarks[], tabs[], tabGroups[], windows[]}`，记下每一次 `chrome.*` 写入。
  **断言「真的搬了 / 真的没搬」靠它**，比读 DOM 更直接。
- `window.__fire`：手工派发事件（桩里每次改窗口都走它）。
  - `externalCreate(url)` / `externalRemove(id)`：模拟**界面之外**的变化
  - `loadComplete(id, title)`：模拟「后台那一页加载完了、并给出了标题」
  - `activate(id)`：换活动标签（不抢焦点换不了，只能这样造）
  - `swapId(id)`：模拟**释放把 WebContents 换掉了**——这一枚拿到新 id，浏览器派发 `onReplaced(新, 旧)`
- `window.__path()`：面包屑的文本（压平空白）。
- `window.__enter(title)`：双击进入某个文件夹。
- URL 上的 `?delay=600`：把所有异步 API 拖慢，用来观察数据到达前的加载占位。

桩源码挂在 `/__stub.js` 上（见「跑起来」），所以要改行为时改的是 `stub.js`，不是注入片段。

## 合成树的基线（2026-10-03 实测）

合成树刻意对齐真实数据的形状（书签栏根层 25 个子级、形态 `FFFF|FFF|FFFF|FFFF|FFFFFF`、
记号在下标 4/8/13/18、根层无散装书签），所以下面这些数字可以直接当回归基线：

| 断言 | 期望 |
| --- | --- |
| `#window-list li` 数 | `4`（分组行 + 组内 2 枚 + 散装 1 枚） |
| 左栏标题 | `工作` / `工作 A` / `x.com 的某条推文` / `散装 C` |
| `#left-count` | `3`（内部页面不计） |
| `#archive-list li` 数 | `2`（起点 = 第一个收藏「常用」） |
| 面包屑 | `书签/书签栏/常用` |
| `#archive-count` | `2` |
| `.favs-host .chip` 数 | `6`（**两块视图各 3 个**：左栏那条在 hidden 容器里，DOM 仍然存在） |
| `#save-label` / `#open-label` | `存过去 (0)` / `打开 (0)`（两侧默认都不选） |
| `__calls.bookmarks` / `__calls.tabs` | `0` / `0`（加载界面不写任何东西） |

行尾三档也能一眼验：`工作 A` 给「释放」（`status` 缺省按 `complete` 处理、非活动），
`x.com 的某条推文` 给「加载」（`unloaded`），活动标签`散装 C` **没有**「释放」。

## 四条测量纪律（都是实测踩出来的）

1. **不要读 `DataTransfer.dropEffect`**：合成事件里它**永远是 `'none'`**（由浏览器在真实拖拽会话里管理，
   而 `new DragEvent()` 没有会话），毫无区分力。改用这三样之一：DOM 里的提示标记数（`.is-drop-*`）、
   `event.defaultPrevented`、`__calls` 里有没有真的 `move`。
2. **宽度与纵向布局一律用 `evaluate` 的矩形数据判定，不要肉眼读截图**：
   `page.setViewportSize` 只影响 JS 上下文，不影响截图的渲染宽度——「量到两栏各 566px、用满宽度」
   与「截图里内容挤在左上角一小块」会同时成立。
3. **favicon 必然报 `ERR_BLOCKED_BY_CLIENT`**：桩的 `_favicon` 指向 `chrome-extension://stub/`，
   是预期噪音，与页面功能无关。
4. **页面白屏先查事件桩**：`tabs.on*` / `tabGroups.on*` 缺一个就在入口脚本顶层抛错，整页空白，
   而控制台里只有一条无关报错，很容易看错方向。
