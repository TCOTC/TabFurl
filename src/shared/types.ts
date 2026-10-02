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

/** 采集到的一个标签页。 */
export interface TabSnapshot {
  title: string
  url: string
  pinned: boolean
  /** 所属标签分组的标题；未分组时为 undefined，分组无标题时为空字符串。 */
  groupTitle?: string
  groupColor?: TabGroupColor
  /** 标签在窗口内的顺序，仅用于写入顺序与浏览器一致。 */
  index: number
  lastAccessed?: number
}

/** 一个标签分组，以及组内标签。 */
export interface TabGroupBucket {
  title: string
  color?: TabGroupColor
  tabs: TabSnapshot[]
}

/** 一次窗口采集的结果。 */
export interface WindowSnapshot {
  windowId: number
  capturedAt: number
  /** 有分组的标签，按分组在窗口内的首次出现顺序。 */
  groups: TabGroupBucket[]
  /** 窗口内未分组的标签。 */
  ungrouped: TabSnapshot[]
  /** 因是浏览器内部页面而跳过的数量。 */
  skipped: number
}

export interface CaptureResult {
  /** 本次创建的会话文件夹；一条都没保存时为空字符串。 */
  folderId: string
  folderName: string
  saved: number
  skipped: number
  /** 创建的分组子文件夹数量。 */
  groups: number
}

export interface RestoreOptions {
  /** 打开的标签放到新窗口还是当前窗口。 */
  target: 'newWindow' | 'currentWindow'
  /** 顶层散装书签是否也建一个「未分组」分组。 */
  groupUngrouped: boolean
}

export interface RestoreResult {
  opened: number
  groups: number
  skipped: number
}

/** 采集字段在 UI 里的展示信息。 */
export interface FolderOption {
  id: string
  title: string
  /** 从存档根算起的层级路径，不含自身。 */
  path: string[]
  /** 直属书签数量。 */
  bookmarkCount: number
  /** 全部后代书签数量（含子文件夹）。 */
  totalBookmarkCount: number
  /** 直属子文件夹数量。 */
  folderCount: number
}

export type SessionNameMode = 'datetime' | 'datetimeSite'

export interface Settings {
  /** 存档根文件夹在书签树中的 id；空字符串表示尚未创建。 */
  archiveRootId: string
  /** 存档根文件夹的名字，首次创建时使用。 */
  archiveRootName: string
  sessionNameMode: SessionNameMode
  restoreTarget: RestoreOptions['target']
  groupUngrouped: boolean
  /** 最近一次保存创建的会话文件夹 id，用于撤销。 */
  lastSessionFolderId?: string
}

export const DEFAULT_SETTINGS: Settings = {
  archiveRootId: '',
  archiveRootName: '标签页存档',
  sessionNameMode: 'datetime',
  restoreTarget: 'newWindow',
  groupUngrouped: false
}
