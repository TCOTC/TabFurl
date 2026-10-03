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
  settings.defaultFolderId = 'root-x'
  assert.equal(DEFAULT_SETTINGS.defaultFolderId, '')
})

test('存储里只有部分字段时与默认值合并', async () => {
  store.settings = {}

  const settings = await loadSettings()

  assert.equal(settings.defaultFolderId, '', '读不到的字段回落到默认值')
})

test('saveSettings 写入约定的存储键', async () => {
  const settings = {...DEFAULT_SETTINGS, defaultFolderId: 'root-9'}
  await saveSettings(settings)

  assert.deepEqual(store.settings, settings)
})

test('updateSettings 合并补丁并落盘', async () => {
  store.settings = {defaultFolderId: 'root-1'}

  const next = await updateSettings({defaultFolderId: 'root-2'})

  assert.equal(next.defaultFolderId, 'root-2')
  assert.deepEqual(store.settings, next, '返回值应与落盘内容一致')
})

test('loadSettings 原样透传存储里的值，不做校验', async () => {
  // 写入方必须保证合法（选择器只写书签栏里的 id）；读取方直接信任存储，
  // 不引入「纠正脏值」这类逻辑——指向已不存在的 id 时，由使用方按「未指定」处理。
  store.settings = {defaultFolderId: '这个-id-已经不存在了'}

  const settings = await loadSettings()

  assert.equal(settings.defaultFolderId, '这个-id-已经不存在了')
})
