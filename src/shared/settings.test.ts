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
  settings.archiveRootId = 'root-x'
  assert.equal(DEFAULT_SETTINGS.archiveRootId, '')
})

test('存储里只有部分字段时与默认值合并', async () => {
  store.settings = {lastSessionFolderId: 'session-1'}

  const settings = await loadSettings()

  assert.equal(settings.archiveRootId, '', '读不到的字段回落到默认值')
  assert.equal(settings.lastSessionFolderId, 'session-1')
})

test('saveSettings 写入约定的存储键', async () => {
  const settings = {...DEFAULT_SETTINGS, archiveRootId: 'root-9'}
  await saveSettings(settings)

  assert.deepEqual(store.settings, settings)
})

test('updateSettings 合并补丁并落盘', async () => {
  store.settings = {archiveRootId: 'root-1', lastSessionFolderId: 'old'}

  const next = await updateSettings({archiveRootId: 'root-2'})

  assert.equal(next.lastSessionFolderId, 'old', '未提及的字段必须保留')
  assert.equal(next.archiveRootId, 'root-2')
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
  // 写入方必须保证合法（选择器只写书签栏里的 id）；读取方直接信任存储，
  // 不引入「纠正脏值」这类逻辑——指向已不存在的 id 时，由使用方按「未指定」处理。
  store.settings = {archiveRootId: '这个-id-已经不存在了'}

  const settings = await loadSettings()

  assert.equal(settings.archiveRootId, '这个-id-已经不存在了')
})
