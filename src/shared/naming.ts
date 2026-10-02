import type {TabGroupBucket, TabGroupColor} from './types'

/** 文件夹名最大长度。浏览器没有硬限制，截断只是为了列表和导出好看。 */
export const MAX_FOLDER_NAME_LENGTH = 100

/** 会话名里自定义名与时间戳的分隔符。 */
export const SESSION_NAME_SEPARATOR = ' · '

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
 * 会话文件夹名：可选的自定义名 + 时间戳（名字在前）。
 *
 * 返回的是**最终名字**（已清洗、已按预算截断），所以界面可以拿它做「将存成这个」的预览。
 *
 * 名字单独按预算截断，而不是把拼好的整串一起截：否则名字一长，截断就会把末尾的
 * 时间戳切掉——那是唯一的排序依据，不能丢。
 *
 * @param name 自定义名；空串或只有空白时只返回时间戳。
 */
export function formatSessionName(date: Date = new Date(), name?: string): string {
  // 时间戳里的冒号会被清洗成下划线（见 sanitizeFolderName），长度不变。
  const stamp = sanitizeFolderName(formatTimestamp(date), formatTimestamp(date))
  const separator = SESSION_NAME_SEPARATOR
  const budget = MAX_FOLDER_NAME_LENGTH - stamp.length - separator.length

  const label = name?.trim()
    ? sanitizeFolderName(name, '', Math.max(1, budget))
    : ''

  return label ? `${label}${separator}${stamp}` : stamp
}

/** 标签分组 → 子文件夹名。空标题分组用颜色消歧，因为用户在不同窗口里就是靠颜色区分的。 */
export function groupFolderName(bucket: Pick<TabGroupBucket, 'title' | 'color'>): string {
  const title = bucket.title.trim()
  if (title) return sanitizeFolderName(title, UNNAMED_GROUP_NAME)

  const colorLabel = bucket.color ? GROUP_COLOR_LABELS[bucket.color] : '无颜色'
  return sanitizeFolderName(`${UNNAMED_GROUP_NAME}（${colorLabel}）`, UNNAMED_GROUP_NAME)
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
