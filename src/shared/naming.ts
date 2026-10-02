import type {TabGroupBucket, TabGroupColor} from './types'

/** 存档里用来收纳「窗口内未分组标签」的文件夹名。 */
export const UNGROUPED_FOLDER_NAME = '未分组'

/** 文件夹名最大长度。浏览器没有硬限制，截断只是为了列表和导出好看。 */
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
/** 这些字符在浏览器里合法，替换掉纯粹是为将来「导出为文件路径」留后路。 */
const RESERVED_PATH_CHARS = /[\\/:*?"<>|]+/g
const WHITESPACE = /\s+/g

/**
 * 清洗文件夹名：折叠空白 → 去控制字符 → 替换路径保留字符 → 截断。
 *
 * @param fallback 清洗后为空时使用的名字（调用方必须显式给出，避免悄悄产生空文件夹名）。
 */
export function sanitizeFolderName(
  raw: string,
  fallback: string,
  maxLength = MAX_FOLDER_NAME_LENGTH
): string {
  const cleaned = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(RESERVED_PATH_CHARS, '_')
    .replace(WHITESPACE, ' ')
    .trim()

  if (!cleaned) return fallback
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间 `YYYY-MM-DD HH:mm`：零填充，字典序即时间序。 */
export function formatTimestamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/**
 * 会话文件夹名。加上站点后缀是为了在同一分钟内保存多个窗口时能一眼区分，
 * 但顺序仍然靠完整时间戳保证。
 */
export function formatSessionName(
  date: Date,
  mode: 'datetime' | 'datetimeSite',
  site?: string
): string {
  const stamp = formatTimestamp(date)
  return mode === 'datetimeSite' && site ? `${stamp} · ${site}` : stamp
}

/** 标签分组 → 子文件夹名。空标题分组用颜色消歧，因为用户在不同窗口里就是靠颜色区分的。 */
export function groupFolderName(bucket: Pick<TabGroupBucket, 'title' | 'color'>): string {
  const title = bucket.title.trim()
  if (title) return sanitizeFolderName(title, UNNAMED_GROUP_NAME)

  const colorLabel = bucket.color ? GROUP_COLOR_LABELS[bucket.color] : '无颜色'
  return sanitizeFolderName(`${UNNAMED_GROUP_NAME}（${colorLabel}）`, UNNAMED_GROUP_NAME)
}

/** 未分组桶的文件夹名。 */
export function ungroupedFolderName(): string {
  return sanitizeFolderName(UNGROUPED_FOLDER_NAME, UNGROUPED_FOLDER_NAME)
}

/** 同级重名时追加 ` (2)`、` (3)`……绝不覆盖已有文件夹。 */
export function dedupeName(desired: string, existing: readonly string[]): string {
  const taken = new Set(existing)
  if (!taken.has(desired)) return desired

  for (let n = 2; n < 10000; n++) {
    const candidate = `${desired} (${n})`
    if (!taken.has(candidate)) return candidate
  }
  return `${desired} (${Date.now()})`
}
