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
  // 数组是可变对象：返回同一份引用的话，调用方 push 一个 id 就会写进 DEFAULT_SETTINGS，
  // 于是「默认值」被这一次会话污染，其他调用点读到的就不是真正的默认值了。
  settings.favoriteFolderIds.push('root-x')
  assert.deepEqual(DEFAULT_SETTINGS.favoriteFolderIds, [])
})

test('存储里只有部分字段时与默认值合并', async () => {
  store.settings = {}

  const settings = await loadSettings()

  assert.deepEqual(settings.favoriteFolderIds, [], '读不到的字段回落到默认值')
})

test('saveSettings 写入约定的存储键', async () => {
  const settings = {...DEFAULT_SETTINGS, favoriteFolderIds: ['root-9']}
  await saveSettings(settings)

  assert.deepEqual(store.settings, settings)
})

test('updateSettings 合并补丁并落盘', async () => {
  store.settings = {favoriteFolderIds: ['root-1']}

  const next = await updateSettings({favoriteFolderIds: ['root-2', 'root-3']})

  assert.deepEqual(next.favoriteFolderIds, ['root-2', 'root-3'])
  assert.deepEqual(store.settings, next, '返回值应与落盘内容一致')
})

test('loadSettings 原样透传存储里的值，不做校验', async () => {
  // 写入方必须保证合法（chip 只收藏书签栏里的 id）；读取方直接信任存储，
  // 不引入「纠正脏值」这类逻辑——指向已不存在的 id 时，由使用方按「它不在了」处理
  // （chip 栏会把它剔掉，面板会落到下一个可用的收藏或书签栏）。
  store.settings = {favoriteFolderIds: ['这个-id-已经不存在了']}

  const settings = await loadSettings()

  assert.deepEqual(settings.favoriteFolderIds, ['这个-id-已经不存在了'])
})
