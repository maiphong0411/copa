import type { editor as MonacoEditor } from 'monaco-editor'
import { createEditor, createModel, monaco } from '../editor/monaco'
import type { FSProvider } from '../fs/types'
import { basename, isInside } from '../fs/path'

interface OpenDoc {
  path: string
  model: MonacoEditor.ITextModel
  /** Version id as of the last save; compared to detect unsaved edits. */
  savedVersionId: number
  /** Cursor, scroll and folding state, so switching tabs resumes where you left. */
  viewState: MonacoEditor.ICodeEditorViewState | null
}

/**
 * Owns the open documents, the tab strip, and the single editor instance.
 *
 * One editor with swapped models — not one editor per file — is how VS Code
 * does it too: models are cheap and hold the undo stack, editors are expensive
 * DOM+layout machinery.
 */
export class Workspace {
  #docs = new Map<string, OpenDoc>()
  #order: string[] = []
  #active: string | null = null
  #editor: MonacoEditor.IStandaloneCodeEditor
  #tabBar: HTMLElement
  #placeholder: HTMLElement

  onDidChange: () => void = () => {}

  constructor(
    private fs: FSProvider,
    opts: { editorHost: HTMLElement; tabBar: HTMLElement; placeholder: HTMLElement },
  ) {
    this.#editor = createEditor(opts.editorHost)
    this.#tabBar = opts.tabBar
    this.#placeholder = opts.placeholder

    this.#editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void this.saveActive()
    })
    this.#tabBar.addEventListener('click', (e) => this.#onTabBarClick(e))
    this.#tabBar.addEventListener('auxclick', (e) => {
      if ((e as MouseEvent).button === 1) this.#onTabBarClick(e, true)
    })
    this.#render()
  }

  get activePath(): string | null {
    return this.#active
  }

  get editor(): MonacoEditor.IStandaloneCodeEditor {
    return this.#editor
  }

  get openPaths(): readonly string[] {
    return this.#order
  }

  isDirty(path: string): boolean {
    const doc = this.#docs.get(path)
    return !!doc && doc.model.getAlternativeVersionId() !== doc.savedVersionId
  }

  get hasUnsaved(): boolean {
    return this.#order.some((p) => this.isDirty(p))
  }

  async open(path: string): Promise<void> {
    if (!this.#docs.has(path)) {
      const text = await this.fs.readFile(path)
      const model = createModel(path, text)
      const doc: OpenDoc = {
        path,
        model,
        savedVersionId: model.getAlternativeVersionId(),
        viewState: null,
      }
      // Any edit can flip the dirty flag, which the tab strip and status bar
      // both display — so one listener per model drives both.
      model.onDidChangeContent(() => {
        this.#renderTabs()
        this.onDidChange()
      })
      this.#docs.set(path, doc)
      this.#order.push(path)
    }
    this.#activate(path)
  }

  #activate(path: string): void {
    if (this.#active && this.#active !== path) {
      const prev = this.#docs.get(this.#active)
      if (prev) prev.viewState = this.#editor.saveViewState()
    }
    const doc = this.#docs.get(path)
    if (!doc) return

    this.#active = path
    this.#editor.setModel(doc.model)
    if (doc.viewState) this.#editor.restoreViewState(doc.viewState)
    this.#editor.focus()
    this.#render()
    this.onDidChange()
  }

  async saveActive(): Promise<void> {
    if (this.#active) await this.save(this.#active)
  }

  async save(path: string): Promise<void> {
    const doc = this.#docs.get(path)
    if (!doc) return
    await this.fs.writeFile(path, doc.model.getValue())
    doc.savedVersionId = doc.model.getAlternativeVersionId()
    this.#renderTabs()
    this.onDidChange()
  }

  async saveAll(): Promise<void> {
    for (const path of [...this.#order]) {
      if (this.isDirty(path)) await this.save(path)
    }
  }

  close(path: string, force = false): boolean {
    const doc = this.#docs.get(path)
    if (!doc) return true
    if (!force && this.isDirty(path)) {
      const keep = !confirm(`${basename(path)} has unsaved changes.\n\nClose without saving?`)
      if (keep) return false
    }

    const index = this.#order.indexOf(path)
    this.#order.splice(index, 1)
    this.#docs.delete(path)
    doc.model.dispose()

    if (this.#active === path) {
      this.#active = null
      // Falling back to the neighbour on the left matches what every editor
      // does and keeps focus near where you were working.
      const next = this.#order[Math.min(index, this.#order.length - 1)]
      if (next) this.#activate(next)
      else {
        this.#editor.setModel(null)
        this.#render()
        this.onDidChange()
      }
    } else {
      this.#render()
      this.onDidChange()
    }
    return true
  }

  /** Drop tabs for paths that no longer exist (after a delete). */
  closeUnder(path: string): void {
    for (const open of [...this.#order]) {
      if (isInside(path, open) || open === path) this.close(open, true)
    }
  }

  /**
   * Re-point an open tab after its file moved.
   *
   * A model's uri is immutable and the language is derived from it, so a moved
   * file needs a brand new model. Undo history is what that costs. Unsaved text
   * is carried across rather than re-read from disk, since disk only has the
   * last saved version.
   */
  async relocate(from: string, to: string): Promise<void> {
    const doc = this.#docs.get(from)
    if (!doc) return
    const wasActive = this.#active === from
    const text = doc.model.getValue()
    const dirty = this.isDirty(from)

    this.close(from, true)
    await this.open(to)

    const moved = this.#docs.get(to)
    if (moved && dirty) {
      moved.model.setValue(text)
      // savedVersionId can never match again, which is exactly right: the
      // carried-over edits are still unsaved.
      moved.savedVersionId = -1
    }
    if (!wasActive && this.#active) this.#activate(this.#active)
    this.#render()
  }

  #onTabBarClick(e: Event, middle = false): void {
    const target = e.target as HTMLElement
    const tab = target.closest<HTMLElement>('.tab')
    if (!tab) return
    const path = tab.dataset.path
    if (!path) return

    if (middle || target.closest('.tab-close')) {
      e.preventDefault()
      this.close(path)
    } else {
      this.#activate(path)
    }
  }

  #render(): void {
    this.#renderTabs()
    const empty = this.#order.length === 0
    this.#placeholder.hidden = !empty
    this.#tabBar.hidden = empty
  }

  #renderTabs(): void {
    this.#tabBar.replaceChildren(
      ...this.#order.map((path) => {
        const tab = document.createElement('div')
        tab.className = 'tab' + (path === this.#active ? ' active' : '')
        tab.dataset.path = path
        tab.title = path

        const label = document.createElement('span')
        label.className = 'tab-label'
        label.textContent = basename(path)

        const close = document.createElement('button')
        close.className = 'tab-close'
        close.setAttribute('aria-label', `Close ${basename(path)}`)
        // A filled dot replacing the × is VS Code's unsaved affordance: it
        // marks state and stays clickable, instead of adding a second control.
        close.textContent = this.isDirty(path) ? '●' : '✕'
        if (this.isDirty(path)) close.classList.add('dirty')

        tab.append(label, close)
        return tab
      }),
    )
  }
}
