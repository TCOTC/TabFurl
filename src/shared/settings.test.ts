import {beforeEach, test} from 'node:test'
import assert from 'node:assert/strict'
import {loadSettings, saveSettings, updateSettings} from './settings'
import {DEFAULT_SETTINGS} from './types'

let store: Record<string, unknown>

beforeEach(() => {
  store = {}
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in store ? {[key]: store[key]} : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }
      }
    }
  }
})

test('没有存储时返回默认设置', async () => {
  assert.deepEqual(await loadSettings(), DEFAULT_SETTINGS)
})

test('返回的是默认设置的新副本，不会污染默认值', async () => {
  const settings = await loadSettings()
  settings.sessionNameMode = 'datetimeSite'
  assert.equal(DEFAULT_SETTINGS.sessionNameMode, 'datetime')
})

test('存储里只有部分字段时与默认值合并', async () => {
  store.settings = {archiveRootId: 'abc', restoreTarget: 'currentWindow'}

  const settings = await loadSettings()

  assert.equal(settings.archiveRootId, 'abc')
  assert.equal(settings.restoreTarget, 'currentWindow')
  assert.equal(settings.sessionNameMode, DEFAULT_SETTINGS.sessionNameMode)
})

test('saveSettings 写入约定的存储键', async () => {
  const settings = {...DEFAULT_SETTINGS, archiveRootId: 'root-9'}
  await saveSettings(settings)

  assert.deepEqual(store.settings, settings)
})

test('updateSettings 合并补丁并落盘', async () => {
  store.settings = {archiveRootId: 'root-1', restoreTarget: 'currentWindow'}

  const next = await updateSettings({sessionNameMode: 'datetimeSite'})

  assert.equal(next.archiveRootId, 'root-1', '未提及的字段必须保留')
  assert.equal(next.restoreTarget, 'currentWindow')
  assert.equal(next.sessionNameMode, 'datetimeSite')
  assert.deepEqual(store.settings, next, '返回值应与落盘内容一致')
})

test('updateSettings 可以写入撤销用的 lastSessionFolderId', async () => {
  const next = await updateSettings({lastSessionFolderId: 'session-42'})
  assert.equal(next.lastSessionFolderId, 'session-42')
  assert.equal((store.settings as {lastSessionFolderId?: string}).lastSessionFolderId, 'session-42')

  const cleared = await updateSettings({lastSessionFolderId: undefined})
  assert.equal(cleared.lastSessionFolderId, undefined)
})

test('loadSettings 原样透传存储里的值，不做校验', async () => {
  // 写入方必须保证合法（设置页只写联合类型里的值）；读取方直接信任存储，
  // 不引入「纠正脏值」这类逻辑。
  store.settings = {sessionNameMode: 'nonsense'}

  const settings = await loadSettings()

  assert.equal(settings.sessionNameMode, 'nonsense' as typeof settings.sessionNameMode)
})
