/** 书签树节点：`chrome.bookmarks.BookmarkTreeNode` 的自有子集，避免领域层依赖具体 API 类型。 */
export interface BookmarkNode {
  id: string
  parentId?: string
  title: string
  /** 书签才有 url；文件夹没有。 */
  url?: string
  dateAdded?: number
  children?: BookmarkNode[]
}

export type TabGroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange'

/**
 * 标签的加载状态，取自 `chrome.tabs.Tab.status`。
 *
 * `unloaded` 就是「被 Chrome 卸载了」：内容被丢掉、地址还留着，点开才重新加载。
 * 用 `status` 而不是 `Tab.discarded`：两者在这个状态下等价（Chrome 自己的 API 测试断言
 * 卸载时 `status === 'unloaded'`），但 `status` 能把「正在加载」也表达出来，
 * 而界面恰好需要那一档（点过「加载」之后到页面给出标题之前）。
 */
export type TabStatus = 'unloaded' | 'loading' | 'complete'

/** 采集到的一个标签页。 */
export interface TabSnapshot {
  /**
   * `chrome.tabs.Tab.id`。
   *
   * 界面里「保留哪几枚标签」用它做标识：标签 id 在标签存活期间不变，
   * 而 `index` 会因为别的标签关闭而整体前移，不能拿它记住用户的勾选。
   */
  tabId: number
  title: string
  url: string
  pinned: boolean
  /** 所属标签分组的标题；未分组时为 undefined，分组无标题时为空字符串。 */
  groupTitle?: string
  groupColor?: TabGroupColor
  /**
   * 所属标签分组的 id；未分组时为 undefined。
   *
   * 与 `groupTitle` 是两件事：标题是给写入书签用的（分组名 → 文件夹名），
   * 而这个 id 是给 `chrome.tabs.group()` 用的——把标签拖进某个分组必须给出 groupId，
   * 拿标题去反查是不行的（同名分组合法存在）。
   */
  groupId?: number
  /** 标签在窗口内的顺序，仅用于写入顺序与浏览器一致。 */
  index: number
  lastAccessed?: number
  /**
   * 网页的加载状态（`Tab.status`）。
   *
   * 只给界面用：左栏的行尾据此决定给不给「加载」/「释放」（`unloaded` 时可点「加载」、
   * `loading` 时显示「加载中」、`complete` 时显示「释放」）。
   * 不参与写入与还原——书签只认标题与网址。
   */
  status: TabStatus
  /**
   * 这一枚是否是所在窗口的**活动**标签（`Tab.active`）。
   *
   * 只给界面用，而且只决定一件事：**活动标签不给「释放」**。
   * 理由不是 API 拒绝（`tabs.discard` 用的 EXTERNAL 理由连活动标签都允许），
   * 而是它就在屏幕上：卸载一个看得见的页面没意义（浏览器马上就会把它读回来）。
   * Chromium 自己的 discards 页用的是同一条判据（`visibility !== VISIBLE`）。
   */
  active: boolean
}

/** 一个标签分组，以及组内标签。 */
export interface TabGroupBucket {
  title: string
  color?: TabGroupColor
  tabs: TabSnapshot[]
}

/**
 * 一次窗口采集的结果。
 *
 * `groups` 与 `ungrouped` 分开只是为了调用方好取用：两者都带着窗口内的位置
 * （`TabSnapshot.index`），按 `index` 归并就能还原标签在窗口里的真实先后。
 */
export interface WindowSnapshot {
  windowId: number
  capturedAt: number
  /** 有分组的标签，按分组在窗口内的首次出现顺序；`tabs` 按 index 升序。 */
  groups: TabGroupBucket[]
  /** 窗口内未分组的标签，按 index 升序。 */
  ungrouped: TabSnapshot[]
  /** 因是浏览器内部页面而跳过的数量。 */
  skipped: number
}

/**
 * 一次写入的结果。
 *
 * 两个 id 数组是「撤销上一次保存」的全部依据：没有会话层之后，
 * 撤销就只能是「把这一次新建的东西删掉」，所以写入时必须把 id 收集起来。
 */
export interface SaveResult {
  saved: number
  skipped: number
  /** 创建的分组子文件夹数量。 */
  groups: number
  /** 本次新建的文件夹 id（分组）。 */
  folderIds: string[]
  /** 本次新建的书签 id（顺序即写入顺序）。 */
  bookmarkIds: string[]
}

export interface RestoreOptions {
  /** 打开的标签放到新窗口还是当前窗口。 */
  target: 'newWindow' | 'currentWindow'
  /**
   * 为存档里的子文件夹建标签分组。
   *
   * 显式传 `false` 时只按顺序开标签、不建分组——用于「只想看看这些页面」的场合。
   * 默认开启；散装书签任何时候都不建分组。
   */
  groupTabs?: boolean
  /** 不还原的书签 id（界面里取消勾选的项）。默认全部还原。 */
  excludeBookmarkIds?: ReadonlySet<string>
}

export interface RestoreResult {
  opened: number
  groups: number
  skipped: number
  /**
   * 已打开但**未加载**的标签数（被 `tabs.discard` 卸载，点开时才加载）。
   *
   * 永远比 `opened` 少 1（每个窗口留一枚活动标签保持加载，API 不允许舍弃它）。
   */
  discarded: number
}

/** 采集字段在 UI 里的展示信息。 */
export interface FolderOption {
  id: string
  title: string
  /** 相对所属根的层级路径，不含自身（也不含根自己，调用方补头部）。 */
  path: string[]
  /** 直属书签数量。 */
  bookmarkCount: number
  /** 全部后代书签数量（含子文件夹）。 */
  totalBookmarkCount: number
  /** 直属子文件夹数量。 */
  folderCount: number
}

export interface Settings {
  /**
   * 收藏的文件夹（书签树里的 id，按用户排的顺序）。数组里的第一个是右栏的**起点**。
   *
   * 它们只是**书签**，不是边界：右栏可以在书签树里自由导航（包括走到收藏**上面**的层），
   * 写入跟的始终是当前展示的那一层。收藏在这里的意义就是「常用的那几层，一键跳过去」。
   *
   * 必须是用户明确收藏过的文件夹（只列书签栏及其后代），扩展不建根文件夹、也不往「其他书签」里写。
   * id 是设备本地的，所以这一组随时可能失效，读出来之后要能容错（见 `refresh()` 的回退）。
   */
  favoriteFolderIds: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  favoriteFolderIds: []
}
