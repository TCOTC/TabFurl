import type {TabGroupBucket, TabGroupColor} from './types'

/**
 * 文件夹名最大长度。浏览器没有硬限制，截断只是为了列表好看。
 * 它只约束两件事：标签分组名（写进子文件夹）与用户手打的重命名。
 */
export const MAX_FOLDER_NAME_LENGTH = 100

/** 无标题标签分组的兜底名。 */
export const UNNAMED_GROUP_NAME = '未命名分组'

export const GROUP_COLOR_LABELS: Record<TabGroupColor, string> = {
  grey: '灰',
  blue: '蓝',
  red: '红',
  yellow: '黄',
  green: '绿',
  pink: '粉',
  purple: '紫',
  cyan: '青',
  orange: '橙'
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g
const WHITESPACE = /\s+/g

/**
 * 新建文件夹的默认名：本地时间的 `2026-10-02 23:51`。
 * 用时间是因为用户点「新建文件夹」时多数只想先放一下，而手打的名字想不出来（还要先删掉「新建文件夹」）；
 * 时间戳一眼能区分、自带顺序感，回车就能建。想改名的人接着在前面打即可（光标会放在最前面）。
 * 用**本地时间**而不用 `toISOString()`：名字是给人看的，与系统时间保持一致。
 */
export function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/**
 * 清洗文件夹名：去控制字符 → 折叠空白 → 截断。**可打印字符一律保留原文**（含 `/ \ : * ? " < > |`）：
 * Chrome 不禁这些字符，所以不替换（原来那套换成 `_` 的规则只为「导出为文件路径」，该功能没做）。
 * `fallback`：清洗后为空时用的名字（调用方必须显式给出，避免惄惄产生空文件夹名）。
 */
export function sanitizeFolderName(
  raw: string,
  fallback: string,
  maxLength = MAX_FOLDER_NAME_LENGTH
): string {
  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(WHITESPACE, ' ').trim()

  if (!cleaned) return fallback
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned
}

/** 标签分组 → 子文件夹名。空标题分组用颜色消歧，因为用户在不同窗口里就是靠颜色区分的。 */
export function groupFolderName(bucket: Pick<TabGroupBucket, 'title' | 'color'>): string {
  const title = bucket.title.trim()
  if (title) return sanitizeFolderName(title, UNNAMED_GROUP_NAME)

  const colorLabel = bucket.color ? GROUP_COLOR_LABELS[bucket.color] : '无颜色'
  return sanitizeFolderName(`${UNNAMED_GROUP_NAME}（${colorLabel}）`, UNNAMED_GROUP_NAME)
}
