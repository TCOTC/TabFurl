/**
 * 后台脚本只做一件事：让工具栏图标打开侧边栏。
 *
 * setPanelBehavior() 只影响「之后」的点击，所以必须在启动时注册一次；
 * 若塞进 onClicked 里会吞掉用户的第一次点击。
 */
chrome.sidePanel
  .setPanelBehavior({openPanelOnActionClick: true})
  .catch((error: unknown) => {
    console.error('[tabfurl] 无法设置侧边栏点击行为', error)
  })
