import {errorText, setStatus} from './dom'

/**
 * 书签编辑对话框的返回值：`undefined` 表示用户取消。
 */
export interface BookmarkEdit {
  title: string
  url: string
}

/** 对话框的 DOM id，用于 `q()` 查找。 */
const DIALOG_ID = 'bookmark-dialog'

/**
 * 「改标题 + 改网址」的模态对话框。
 *
 * **用 `<dialog>` + `showModal()`**：Esc 关闭、焦点回归、背景惰化与 `::backdrop` 都是白送的
 *（自己搭浮层要几十行而且总会漏一条）。**单例复用**：`showModal()` 对已打开的 dialog 会抛
 * `InvalidStateError`，复用时先 `close()` 再开，竞态就不存在了。
 *
 * 标题可留空（Chrome 会退回去显示网址）；**网址必须非空**（留空时返回一句错误，不静默接受）。
 */
export function openBookmarkDialog(
  host: HTMLElement,
  initial: BookmarkEdit,
  onSubmit: (edit: BookmarkEdit) => Promise<void>
): void {
  const dialog = ensureDialog(host)
  const form = dialog.querySelector<HTMLFormElement>('form')
  const titleInput = dialog.querySelector<HTMLInputElement>('[data-field="title"]')
  const urlInput = dialog.querySelector<HTMLInputElement>('[data-field="url"]')
  const status = dialog.querySelector<HTMLParagraphElement>('[data-field="status"]')
  if (!form || !titleInput || !urlInput || !status) return

  setStatus(status, '', 'ok')
  titleInput.value = initial.title
  urlInput.value = initial.url

  // 单例复用：已打开时先关掉，避免 `showModal()` 抛 InvalidStateError。
  if (dialog.open) dialog.close()
  dialog.showModal()
  titleInput.focus()
  titleInput.select()

  const submit = async (): Promise<void> => {
    const url = urlInput.value.trim()
    if (!url) {
      setStatus(status, '网址不能为空。', 'error')
      urlInput.focus()
      return
    }
    const submitButton = dialog.querySelector<HTMLButtonElement>('[data-field="confirm"]')
    if (submitButton) submitButton.disabled = true
    try {
      await onSubmit({title: titleInput.value, url})
      dialog.close()
    } catch (error) {
      setStatus(status, `保存失败：${errorText(error)}`, 'error')
    } finally {
      if (submitButton) submitButton.disabled = false
    }
  }

  form.onsubmit = (event) => {
    event.preventDefault()
    void submit()
  }
  // 取消按钮不写 `type="submit"`，走 `formmethod="dialog"` 那条原生路径即可（关闭、不改任何东西）。
}

/** 建一次、之后复用。挂在面板里，这样它的样式跟随面板的 CSS 作用域。 */
function ensureDialog(host: HTMLElement): HTMLDialogElement {
  const existing = host.querySelector<HTMLDialogElement>(`#${DIALOG_ID}`)
  if (existing) return existing

  const dialog = document.createElement('dialog')
  dialog.id = DIALOG_ID
  dialog.className = 'dialog'
  dialog.innerHTML = `
    <form class="dialog__form">
      <h2 class="dialog__title">修改收藏</h2>
      <label class="field">
        <span class="field__label">标题</span>
        <input type="text" class="input" data-field="title" autocomplete="off" />
      </label>
      <label class="field">
        <span class="field__label">网址</span>
        <input type="text" class="input" data-field="url" autocomplete="off" spellcheck="false" />
      </label>
      <p class="status" data-field="status" hidden></p>
      <div class="dialog__actions">
        <button type="button" class="btn" data-field="cancel">取消</button>
        <button type="submit" class="btn btn--primary" data-field="confirm">保存</button>
      </div>
    </form>
  `
  host.append(dialog)

  dialog.querySelector<HTMLButtonElement>('[data-field="cancel"]')?.addEventListener('click', () => {
    dialog.close()
  })

  return dialog
}
