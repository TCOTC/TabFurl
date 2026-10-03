/**
 * 后台脚本只做一件事：点工具栏图标时把主界面作为独立标签页打开。
 *
 * 不走侧边栏（`side_panel`）：主界面需要横向空间（两栏 + 中间一列），挤在窄面板里很难用。
 *
 * **以窗口为单位**：主界面左栏列的是「这个窗口」的标签页 → 点哪个窗口的图标，界面就出现在哪个窗口。
 * 曾经是全局只留一个实例、找到后 `windows.update` 把焦点拽过去，于是在窗口 B 点图标会跳回窗口 A
 *（等于把用户从他正要操作的那一窗拽走）→ 检索时带上 `windowId` 就解决了，同窗连点也不会堆出第二个。
 */
const APP_PAGE = 'pages/app.html'

async function openAppPage(windowId?: number): Promise<void> {
  const url = chrome.runtime.getURL(APP_PAGE)
  const query: chrome.tabs.QueryInfo = {url}
  if (windowId !== undefined) {
    query.windowId = windowId
  }
  const [existing] = await chrome.tabs.query(query)

  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, {active: true})
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, {focused: true})
    }
    return
  }

  await chrome.tabs.create(windowId === undefined ? {url} : {url, windowId})
}

// 必须在顶层注册：MV3 的 service worker 随时会被回收，监听器注册晚了会吞掉点击。
chrome.action.onClicked.addListener((tab) => {
  openAppPage(tab?.windowId).catch((error: unknown) => {
    console.error('[tabfurl] 无法打开主界面', error)
  })
})
