/**
 * 后台脚本只做一件事：点工具栏图标时，把主界面作为独立标签页打开。
 *
 * 主界面不再走侧边栏（`side_panel`），因为它需要横向空间：文件夹列表、搜索、
 * 多选与还原按钮挤在窄面板里很难用。
 *
 * 已经开着就不再开第二个，直接切过去——否则连点几次会堆出一排重复标签。
 * 该页在 `pages/` 特殊目录下，所以它不需要被清单引用也能进入构建产物。
 */
const APP_PAGE = 'pages/app.html'

async function openAppPage(): Promise<void> {
  const url = chrome.runtime.getURL(APP_PAGE)
  const [existing] = await chrome.tabs.query({url})

  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, {active: true})
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, {focused: true})
    }
    return
  }

  await chrome.tabs.create({url})
}

// 必须在顶层注册：MV3 的 service worker 随时会被回收，监听器注册晚了会吞掉点击。
chrome.action.onClicked.addListener(() => {
  openAppPage().catch((error: unknown) => {
    console.error('[tabfurl] 无法打开主界面', error)
  })
})
