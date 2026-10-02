import {DEFAULT_SETTINGS, type Settings} from './types'

const STORAGE_KEY = 'settings'

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY] as Partial<Settings> | undefined
  return {...DEFAULT_SETTINGS, ...value}
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({[STORAGE_KEY]: settings})
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = {...(await loadSettings()), ...patch}
  await saveSettings(next)
  return next
}
