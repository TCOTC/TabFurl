import {DEFAULT_SETTINGS, type Settings} from './types'

const STORAGE_KEY = 'settings'

/**
 * 读设置，与默认值合并。
 * **数组字段必须复制一份**：`{...DEFAULT_SETTINGS}` 是浅拷贝，不复制的话读到的
 * `favoriteFolderIds` 就是 `DEFAULT_SETTINGS` 里那**同一个数组**，调用方一 push/splice 就把「默认值」改掉了。
 */
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY] as Partial<Settings> | undefined
  const ids = value?.favoriteFolderIds
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    favoriteFolderIds: Array.isArray(ids) ? [...ids] : []
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({[STORAGE_KEY]: settings})
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = {...(await loadSettings()), ...patch}
  await saveSettings(next)
  return next
}
