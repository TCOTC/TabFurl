// 预览桩：把真实书签树喂给 chrome.bookmarks，并实现 tabs.tabGroups.windows 的最小可用行为。
// 这段代码在浏览器里被 addInitScript 注入，所以只能用同步 XHR 读书签树。
const req = new XMLHttpRequest()
req.open('GET', '/__tree.json', false)
req.send()
const tree = JSON.parse(req.responseText)

const index = new Map()
const parents = new Map()
const walk = (n) => {
  index.set(n.id, n)
  for (const c of n.children ?? []) {
    parents.set(c.id, n.id)
    walk(c)
  }
}
tree.forEach(walk)

const shape = (n, deep) => ({
  id: n.id,
  title: n.title,
  url: n.url,
  parentId: parents.get(n.id),
  children: deep ? (n.children ?? []).map((c) => shape(c, true)) : undefined
})

/** 按 id 取节点。真 API 找不到就 reject，这里照做——否则会静默拿到一个 `undefined` 组成的形状。 */
const nodeById = (id) => {
  const node = index.get(id)
  if (!node) throw new Error("Can't find bookmark for id: " + id)
  return node
}

const store = {
  // `favoriteFolderIds` 是**有序数组**：第一个可用的是右栏起点，chip 栏靠它渲染。
  // 三个都在书签栏下面（收藏只认书签栏里的层，见 AGENTS.md「收藏文件夹是书签」）。
  settings: {favoriteFolderIds: ['1-5', '1-0', '1-6']}
}
let seq = 0

// `?delay=600` 把所有异步 API 拖慢，用来观察「数据到达前」的加载占位。
const DELAY = Number(new URLSearchParams(location.search).get('delay') ?? 0)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const slow = async () => {
  if (DELAY > 0) await sleep(DELAY)
}

Object.defineProperty(window, 'chrome', {
  value: {
    // `id` 真浏览器上一定有（扩展自己的 id）。右下角那枚「扩展程序」按钮读的就是它。
    runtime: {id: 'stub-extension-id', getURL: (p) => 'chrome-extension://stub/' + p, lastError: undefined},
    bookmarks: {
      getTree: async () => tree.map((n) => shape(n, true)),
      getSubTree: async (id) => {
        await slow()
        return [shape(nodeById(id), true)]
      },
      get: async (id) => [shape(nodeById(id), false)],
      getChildren: async (id) => (nodeById(id).children ?? []).map((c) => shape(c, false)),
      create: async (arg) => {
        const node = {id: 'new' + seq++, title: arg.title, url: arg.url, children: arg.url ? undefined : []}
        index.set(node.id, node)
        parents.set(node.id, arg.parentId)
        ;(index.get(arg.parentId).children ??= []).push(node)
        window.__calls.bookmarks.push({op: 'create', parentId: arg.parentId, title: arg.title, url: arg.url, id: node.id})
        return shape(node, true)
      },
      update: async (id, arg) => {
        const n = index.get(id)
        // 与真 API 一致：只改传了的字段（title / url 各自可选）。
        if (arg.title !== undefined) n.title = arg.title
        if (arg.url !== undefined) n.url = arg.url
        window.__calls.bookmarks.push({op: 'update', id, title: arg.title, url: arg.url})
        return shape(n, false)
      },
      removeTree: async (id) => {
        const n = index.get(id)
        const p = index.get(parents.get(id))
        p.children = p.children.filter((c) => c.id !== id)
        index.delete(id)
        window.__calls.bookmarks.push({op: 'removeTree', id})
      },
      // index 语义与 Chromium 一致：传的是**移动前**坐标系里的插入位置，同父下移时 Chrome 自己会减 1。
      move: async (id, dest) => {
        const n = index.get(id)
        // 父子关系在 parents 这张表里（书签树 JSON 自身不带 parentId）。
        const oldParent = index.get(parents.get(id))
        const oldIndex = oldParent.children.indexOf(n)
        const newParent = index.get(dest.parentId)
        oldParent.children.splice(oldIndex, 1)
        let target = dest.index === undefined ? newParent.children.length : dest.index
        if (oldParent === newParent && target > oldIndex) target -= 1
        newParent.children.splice(target, 0, n)
        parents.set(id, dest.parentId)
        window.__calls.bookmarks.push({op: 'move', id, parentId: dest.parentId, index: dest.index, landedAt: target})
        return shape(n, false)
      },
      onCreated: {addListener() {}},
      onRemoved: {addListener() {}},
      onChanged: {addListener() {}},
      onMoved: {addListener() {}}
    },
    storage: {
      local: {
        get: async (k) => {
          await slow()
          return k in store ? {[k]: store[k]} : {}
        },
        set: async (i) => Object.assign(store, i)
      }
    },
    tabs: {
      // 只实现 `{groupId}` 这一个过滤（关闭整组靠它拿到全量名单，见 allTabIdsInGroup）。
      // 不实现 `windowId`：桩里所有标签都属于同一个窗口，过滤与否结果相同。
      query: async (info) => {
        await slow()
        let list = window.__tabs
        if (info && info.groupId !== undefined) list = list.filter((t) => t.groupId === info.groupId)
        return list.map((t) => ({...t}))
      },
      get: async (id) => {
        const t = window.__tabs.find((x) => x.id === id)
        if (!t) throw new Error('no tab ' + id)
        return {...t}
      },
      create: async (a) => {
        const tab = {id: 900 + window.__tabs.length, index: window.__tabs.length, windowId: 7, title: a.url, url: a.url, pinned: false, groupId: -1, active: false}
        window.__tabs.push(tab)
        window.__calls.tabs.push({op: 'create', url: a.url, index: a.index, windowId: a.windowId})
        // 与真浏览器一样派发事件：界面靠这些事件自己跟上（不靠每个动作自己刷新）。
        window.__fire.created({...tab})
        window.__fire.updated(tab.id, {url: a.url, title: a.url}, {...tab})
        return {...tab}
      },
      // 与 TabListInterface::MoveTab 一致：index 是移动**之后**的位置，越界就夹到最近的有效位置。
      move: async (ids, props) => {
        const list = Array.isArray(ids) ? ids : [ids]
        const target = props.index < 0 ? window.__tabs.length - 1 : Math.min(Math.max(props.index, 0), window.__tabs.length - 1)
        const moving = list.map((id) => window.__tabs.find((t) => t.id === id)).filter(Boolean)
        window.__tabs = window.__tabs.filter((t) => !moving.includes(t))
        window.__tabs.splice(target, 0, ...moving)
        window.__tabs.forEach((t, i) => { t.index = i })
        window.__calls.tabs.push({op: 'move', ids: list, index: props.index, landedIndex: target})
        return moving.map((t) => ({...t}))
      },
      group: async (opts) => {
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds]
        const gid = opts.groupId ?? 100
        for (const id of ids) {
          const t = window.__tabs.find((x) => x.id === id)
          if (t) t.groupId = gid
        }
        window.__calls.tabs.push({op: 'group', ids, groupId: gid})
        for (const id of ids) window.__fire.updated(id, {groupId: gid}, {...(window.__tabs.find((x) => x.id === id) ?? {})})
        return gid
      },
      ungroup: async (ids) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const t = window.__tabs.find((x) => x.id === id)
          if (t) t.groupId = -1
        }
        window.__calls.tabs.push({op: 'ungroup', ids})
      },
      update: async (id, props) => {
        const t = window.__tabs.find((x) => x.id === id)
        window.__calls.tabs.push({op: 'update', id, props})
        return {...(t ?? {id}), windowId: 7}
      },
      // 与真浏览器一致：对已卸载的标签重载就是「加载」，并且会派发 `discarded: false`
      // 与 `status: 'loading'`（Chrome 自己的 API 测试 tabs/basics/discarded/discarded.js
      // 就是这么断言的，两件事永远同时到达）。
      reload: async (id) => {
        const t = window.__tabs.find((x) => x.id === id)
        window.__calls.tabs.push({op: 'reload', id})
        if (t) {
          t.discarded = false
          t.status = 'loading'
          window.__fire.updated(id, {discarded: false, status: 'loading'}, {...t})
        }
        return {...(t ?? {id})}
      },
      // 与真浏览器一致：丢掉内容、保留标题与地址，并派发 `discarded: true` + `status: 'unloaded'`。
      discard: async (id) => {
        const t = window.__tabs.find((x) => x.id === id)
        window.__calls.tabs.push({op: 'discard', id})
        if (!t) throw new Error('No tab with id: ' + id)
        if (t.status === 'unloaded') throw new Error('Cannot discard tab with id: ' + id)
        t.discarded = true
        t.status = 'unloaded'
        window.__fire.updated(id, {discarded: true, status: 'unloaded'}, {...t})
        return {...t}
      },
      // 与真浏览器一致：按 id 移除（数字或数组），并对每一枚派发 onRemoved。
      remove: async (ids) => {
        const list = (Array.isArray(ids) ? ids : [ids]).map(Number)
        window.__calls.tabs.push({op: 'remove', ids: list})
        for (const id of list) {
          const t = window.__tabs.find((x) => x.id === id)
          if (!t) throw new Error('No tab with id: ' + id)
        }
        for (const id of list) {
          window.__tabs = window.__tabs.filter((t) => t.id !== id)
          window.__tabs.forEach((t, i) => { t.index = i })
          window.__fire.removed(id)
        }
        return undefined
      },
      onCreated: {addListener: (fn) => window.__listeners.created.push(fn)},
      onRemoved: {addListener: (fn) => window.__listeners.removed.push(fn)},
      onMoved: {addListener: (fn) => window.__listeners.moved.push(fn)},
      onAttached: {addListener() {}},
      onDetached: {addListener() {}},
      onActivated: {addListener: (fn) => window.__listeners.activated.push(fn)},
      // 释放的旧实现会把 WebContents 换成一个空的 → 扩展看到的 tab id 会变，
      // 浏览器因此派发 onReplaced(addedTabId, removedTabId)。
      onReplaced: {addListener: (fn) => window.__listeners.replaced.push(fn)},
      onUpdated: {addListener: (fn) => window.__listeners.updated.push(fn)}
    },
    tabGroups: {
      get: async (id) => ({id, title: window.__groupTitles[String(id)] ?? '工作', color: 'blue'}),
      update: async (id, props) => {
        window.__groupTitles[String(id)] = props.title
        window.__calls.tabGroups.push({id, title: props.title})
        return {id, title: props.title, color: 'blue'}
      },
      onUpdated: {addListener: (fn) => window.__listeners.groupUpdated.push(fn)},
      onRemoved: {addListener() {}}
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      getCurrent: async () => ({id: 7}),
      update: async () => ({}),
      create: async (a) => {
        window.__calls.windows.push(a)
        return {id: 42, tabs: [{id: 950}]}
      }
    }
  },
  configurable: true,
  writable: true
})

// 左栏的四个标签：一个分组的三枚（其中一枚是**浏览器内部页面**，界面会跳过它）+ 一枚散装。
// 第 3 枚故意**不带 status 字段**，验证缺字段时按「已加载」处理；第 4 枚是活动标签（不给「释放」）。
window.__tabs = [
  {id: 1, index: 0, windowId: 7, title: '工作 A', url: 'https://a.example/', pinned: false, groupId: 100, active: false},
  {id: 2, index: 1, windowId: 7, title: 'x.com 的某条推文', url: 'https://x.com/a/status/1', pinned: false, groupId: 100, active: false, status: 'unloaded'},
  {id: 4, index: 2, windowId: 7, title: '新标签页', url: 'chrome://newtab/', pinned: false, groupId: 100, active: false},
  {id: 3, index: 3, windowId: 7, title: '散装 C', url: 'https://c.example/', pinned: false, groupId: -1, active: true, status: 'complete'}
]
window.__groupTitles = {100: '工作'}
window.__calls = {bookmarks: [], tabs: [], tabGroups: [], windows: []}
window.__listeners = {created: [], removed: [], moved: [], updated: [], groupUpdated: [], activated: [], replaced: []}
// 统一的派发入口：界面靠事件自己跟上，桩里每次改窗口都要走它。
window.__fire = {
  created: (tab) => window.__listeners.created.forEach((fn) => fn({...tab})),
  removed: (id) => window.__listeners.removed.forEach((fn) => fn(id, {windowId: 7, isWindowClosing: false})),
  moved: (id, from, to) => window.__listeners.moved.forEach((fn) => fn(id, {windowId: 7, fromIndex: from, toIndex: to})),
  updated: (id, info, tab) => window.__listeners.updated.forEach((fn) => fn(id, info, tab)),
  // 供测试直接调用：模拟「界面之外」新建 / 关闭一枚标签。
  externalCreate: (url) => {
    const tab = {id: 800 + window.__tabs.length, index: window.__tabs.length, windowId: 7, title: url, url, pinned: false, groupId: -1, active: false}
    window.__tabs.push(tab)
    window.__fire.created(tab)
    return tab
  },
  externalRemove: (id) => {
    window.__tabs = window.__tabs.filter((t) => t.id !== id)
    window.__tabs.forEach((t, i) => { t.index = i })
    window.__fire.removed(id)
  },
  // 模拟「后台那一页加载完了、并给出了标题」（x.com 这类重 SPA 要切过去才会走到这一步）。
  loadComplete: (id, title) => {
    const t = window.__tabs.find((x) => x.id === id)
    if (!t) throw new Error('no tab ' + id)
    t.status = 'complete'
    t.title = title
    window.__fire.updated(id, {status: 'complete', title}, {...t})
    return {...t}
  },
  // 模拟「活动标签变了」（不抢焦点就换不了活动标签，所以只能这样造）。
  activate: (id) => {
    for (const t of window.__tabs) t.active = t.id === id
    window.__listeners.activated.forEach((fn) => fn({tabId: id, windowId: 7}))
  },
  // 模拟「释放把 WebContents 换掉了」：这一枚拿到**新 id**，浏览器派发 onReplaced(新, 旧)。
  swapId: (id) => {
    const t = window.__tabs.find((x) => x.id === id)
    if (!t) throw new Error('no tab ' + id)
    const next = 900 + window.__tabs.length
    t.id = next
    t.tabId = next
    window.__listeners.replaced.forEach((fn) => fn(next, id))
    return next
  }
}
window.__path = () => document.querySelector('#archive-path').textContent.replace(/\s+/g, ' ').trim()
window.__enter = (title) => {
  const row = [...document.querySelectorAll('#archive-list [data-enter-folder]')]
    .find((el) => el.querySelector('.item__title')?.textContent === title)
  if (!row) throw new Error('找不到文件夹行：' + title)
  row.querySelector('.item__main').dispatchEvent(new MouseEvent('dblclick', {bubbles: true, view: window}))
}
