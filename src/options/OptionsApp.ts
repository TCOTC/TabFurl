import {ensureArchiveRoot, getNode, getNodePath} from '../shared/bookmarks'
import {loadSettings, saveSettings} from '../shared/settings'
import {DEFAULT_SETTINGS, type Settings} from '../shared/types'

const ROOT_TEMPLATE = `
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">TabFurl 设置</h1>
      <p class="app__subtitle">配置存档位置与还原行为</p>
    </header>

    <section class="card">
      <h2 class="panel__title">存档根文件夹</h2>
      <label class="field">
        <span class="field__label">文件夹名</span>
        <input type="text" class="input" id="root-name" autocomplete="off" />
      </label>
      <p class="muted" id="root-status"></p>
      <div class="row">
        <button type="button" class="btn btn--primary" id="root-create-btn">创建 / 定位</button>
      </div>
      <p class="muted">
        存档会创建在「其他书签」下。已有的浏览器收藏夹、同步与导入导出功能不受影响。
      </p>
    </section>

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

  const rootNameInput = q<HTMLInputElement>(root, '#root-name')
  const rootStatus = q<HTMLParagraphElement>(root, '#root-status')
  const rootCreateButton = q<HTMLButtonElement>(root, '#root-create-btn')
  const saveButton = q<HTMLButtonElement>(root, '#save-btn')
  const resetButton = q<HTMLButtonElement>(root, '#reset-btn')
  const saveStatus = q<HTMLParagraphElement>(root, '#save-status')

  let settings: Settings = {...DEFAULT_SETTINGS}

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
      rootStatus.textContent = '尚未创建。填好名字后点「创建 / 定位」。'
      return
    }
    const path = await getNodePath(id)
    rootStatus.textContent = `当前存档根：${path.join(' / ')}`
  }

  function readForm(): Settings {
    return {
      ...settings,
      archiveRootName: rootNameInput.value.trim() || DEFAULT_SETTINGS.archiveRootName,
      sessionNameMode:
        radioValue('session-name-mode') === 'datetimeSite' ? 'datetimeSite' : 'datetime',
      restoreTarget: radioValue('restore-target') === 'currentWindow'
        ? 'currentWindow'
        : 'newWindow'
    }
  }

  function fillForm(): void {
    rootNameInput.value = settings.archiveRootName
    setRadio('session-name-mode', settings.sessionNameMode)
    setRadio('restore-target', settings.restoreTarget)
    void describeRoot()
  }

  rootCreateButton.addEventListener('click', async () => {
    rootCreateButton.disabled = true
    try {
      settings = readForm()
      const node = await ensureArchiveRoot(settings.archiveRootName)
      settings = {...settings, archiveRootId: node.id}
      await saveSettings(settings)
      setStatus('存档根已就绪。', 'ok')
      await describeRoot()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      rootCreateButton.disabled = false
    }
  })

  saveButton.addEventListener('click', async () => {
    settings = readForm()
    await saveSettings(settings)
    setStatus('已保存。', 'ok')
    await describeRoot()
  })

  resetButton.addEventListener('click', async () => {
    // 只重置偏好，不动已经建好的书签文件夹。
    settings = {...DEFAULT_SETTINGS, archiveRootId: settings.archiveRootId}
    await saveSettings(settings)
    fillForm()
    setStatus('已恢复默认（已建好的存档保留在原处）。', 'ok')
  })

  void loadSettings().then((loaded) => {
    settings = loaded
    fillForm()
  })
}

OptionsApp()
