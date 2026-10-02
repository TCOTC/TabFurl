import {getNode, getNodePath, listArchiveRootCandidates} from '../shared/bookmarks'
import {loadSettings, saveSettings, updateSettings} from '../shared/settings'
import {DEFAULT_SETTINGS, type FolderOption, type Settings} from '../shared/types'

const ROOT_TEMPLATE = `
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">TabFurl 设置</h1>
      <p class="app__subtitle">配置存档位置与还原行为</p>
    </header>

    <section class="card">
      <h2 class="panel__title">存档位置</h2>
      <label class="field">
        <span class="field__label">存档根文件夹（书签栏内）</span>
        <select class="input" id="root-select"></select>
      </label>
      <p class="muted" id="root-status"></p>
      <div class="row">
        <button type="button" class="btn btn--ghost" id="root-refresh-btn">重新读取书签栏</button>
      </div>
      <p class="muted">
        存档直接写进选中的文件夹，不会再包一层。扩展不会自己建文件夹，也不往「其他书签」里写东西。
        它下面的每个子文件夹都会被当成一次存档，所以最好专为它建一个文件夹。
        列表里没有合适的选项时，先在书签管理器里于「书签栏」下新建一个，再点「重新读取书签栏」。
      </p>    </section>

    <section class="card">
      <h2 class="panel__title">会话文件夹命名</h2>
      <label class="check">
        <input type="radio" name="session-name-mode" value="datetime" />
        <span><code>2026-10-02 14:30</code><br /><span class="muted">本地日期时间，字典序即时间序</span></span>
      </label>
      <label class="check">
        <input type="radio" name="session-name-mode" value="datetimeSite" />
        <span><code>2026-10-02 14:30 · github.com</code><br /><span class="muted">额外带上当时活动标签的站点，便于分辨同一分钟保存的多个窗口</span></span>
      </label>
    </section>

    <section class="card">
      <h2 class="panel__title">还原行为</h2>
      <div class="field">
        <span class="field__label">标签打开到</span>
        <label class="check">
          <input type="radio" name="restore-target" value="newWindow" />
          <span>新窗口</span>
        </label>
        <label class="check">
          <input type="radio" name="restore-target" value="currentWindow" />
          <span>当前窗口</span>
        </label>
      </div>
      <p class="muted">
        还原时按存档文件夹的子文件夹（一层）创建标签分组；文件夹里没进子文件夹的散装书签，
        会按它们原来的位置还原成未分组的标签。更深的嵌套会被跳过，统计里会给出数量。
      </p>
    </section>

    <div class="row">
      <button type="button" class="btn btn--primary" id="save-btn">保存设置</button>
      <button type="button" class="btn btn--ghost" id="reset-btn">恢复默认</button>
      <span class="status" id="save-status"></span>
    </div>
  </main>
`

function q<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`缺少必需的 DOM 节点：${selector}`)
  return element as T
}

function OptionsApp(): void {
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = ROOT_TEMPLATE

  const rootSelect = q<HTMLSelectElement>(root, '#root-select')
  const rootStatus = q<HTMLParagraphElement>(root, '#root-status')
  const rootRefreshButton = q<HTMLButtonElement>(root, '#root-refresh-btn')
  const saveButton = q<HTMLButtonElement>(root, '#save-btn')
  const resetButton = q<HTMLButtonElement>(root, '#reset-btn')
  const saveStatus = q<HTMLParagraphElement>(root, '#save-status')

  let settings: Settings = {...DEFAULT_SETTINGS}
  let barTitle = ''

  function radioValue(name: string): string {
    const checked = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)
    return checked?.value ?? ''
  }

  function setRadio(name: string, value: string): void {
    for (const input of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
      input.checked = input.value === value
    }
  }

  function setStatus(message: string, kind: 'ok' | 'error' | '' = ''): void {
    saveStatus.textContent = message
    saveStatus.className = kind ? `status status--${kind}` : 'status'
  }

  async function describeRoot(): Promise<void> {
    const id = settings.archiveRootId
    if (!id || !(await getNode(id))) {
      rootStatus.textContent = '尚未指定。请从上面的列表里选一个书签栏下的文件夹。'
      return
    }
    const path = await getNodePath(id)
    rootStatus.textContent = `当前存档根：${path.join(' / ')}`
  }

  /** 第 0 项是书签栏自己，其余项的 path 不含书签栏，所以这里补上头部。 */
  function rootOptionLabel(folder: FolderOption, index: number): string {
    if (index === 0) return `${folder.title}（存档直接放在书签栏里）`
    return [barTitle, ...folder.path, folder.title].join(' / ')
  }

  /** 用书签栏重建下拉选项。存档根只能是这份候选列表里的一项。 */
  async function refreshRootOptions(): Promise<void> {
    const {barTitle: title, folders} = await listArchiveRootCandidates()
    barTitle = title

    rootSelect.innerHTML = ''
    for (const [index, folder] of folders.entries()) {
      const element = document.createElement('option')
      element.value = folder.id
      element.textContent = rootOptionLabel(folder, index)
      rootSelect.append(element)
    }
    rootSelect.value = settings.archiveRootId
  }

  function readForm(): Settings {
    return {
      ...settings,
      sessionNameMode:
        radioValue('session-name-mode') === 'datetimeSite' ? 'datetimeSite' : 'datetime',
      restoreTarget: radioValue('restore-target') === 'currentWindow'
        ? 'currentWindow'
        : 'newWindow'
    }
  }

  /** 读书签栏、重建下拉与状态行。读不到时把原因写在状态行里，不把异常抛到控制台。 */
  async function showRoot(): Promise<boolean> {
    try {
      await refreshRootOptions()
      await describeRoot()
      return true
    } catch (error) {
      rootSelect.innerHTML = ''
      rootStatus.textContent = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  function fillForm(): void {
    setRadio('session-name-mode', settings.sessionNameMode)
    setRadio('restore-target', settings.restoreTarget)
    void showRoot()
  }

  // 存档位置是单独一次选择，选中就落盘；「保存设置」只管会话命名与还原行为。
  rootSelect.addEventListener('change', async () => {
    const next = await updateSettings({archiveRootId: rootSelect.value})
    settings = {...settings, archiveRootId: next.archiveRootId}
    await describeRoot()
    setStatus('存档位置已更新。', 'ok')
  })

  rootRefreshButton.addEventListener('click', async () => {
    rootRefreshButton.disabled = true
    try {
      if (await showRoot()) setStatus('已重新读取书签栏。', 'ok')
    } finally {
      rootRefreshButton.disabled = false
    }
  })

  saveButton.addEventListener('click', async () => {
    settings = readForm()
    await saveSettings(settings)
    setStatus('已保存。', 'ok')
    await describeRoot()
  })

  resetButton.addEventListener('click', async () => {
    // 只重置偏好，不动已经选好的存档位置。
    settings = {...DEFAULT_SETTINGS, archiveRootId: settings.archiveRootId}
    await saveSettings(settings)
    fillForm()
    setStatus('已恢复默认（存档位置保留不变）。', 'ok')
  })

  void loadSettings().then((loaded) => {
    settings = loaded
    fillForm()
  })
}

OptionsApp()
