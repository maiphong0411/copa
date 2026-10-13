import type { Entry, EntryKind, FSProvider } from '../fs/types'
import { basename, dirname, join, ROOT, validateName } from '../fs/path'

interface TreeHandlers {
  onOpenFile: (path: string) => void | Promise<void>
  onDeleted: (path: string) => void
  onRenamed: (from: string, to: string) => void | Promise<void>
  onError: (message: string) => void
}

interface Pending {
  parent: string
  kind: EntryKind
  /** Set when renaming rather than creating. */
  renaming?: string
}

/**
 * The file explorer.
 *
 * Rendered as a flat list of rows with depth-based indentation rather than
 * nested lists: a tree's visual nesting is purely horizontal padding, and a
 * flat list keeps selection, keyboard movement and re-render trivial.
 *
 * Children are read only for expanded directories, so cost scales with what's
 * on screen, not with the size of the workspace.
 */
export class FileTree {
  #expanded = new Set<string>([ROOT])
  #selected: string | null = null
  #pending: Pending | null = null

  constructor(
    private fs: FSProvider,
    private host: HTMLElement,
    private handlers: TreeHandlers,
  ) {
    this.host.addEventListener('click', (e) => void this.#onClick(e))
    this.host.addEventListener('dblclick', (e) => this.#onDoubleClick(e))
    this.host.addEventListener('contextmenu', (e) => this.#onContextMenu(e))
  }

  get selected(): string | null {
    return this.#selected
  }

  /** Directory new items should land in: the selection, or its parent if a file. */
  async targetDir(): Promise<string> {
    if (!this.#selected) return ROOT
    const kind = await this.#kindOf(this.#selected)
    return kind === 'dir' ? this.#selected : dirname(this.#selected)
  }

  async #kindOf(path: string): Promise<EntryKind> {
    // The tree already knows: a path is a directory iff it can be listed.
    try {
      await this.fs.readDir(path)
      return 'dir'
    } catch {
      return 'file'
    }
  }

  async refresh(): Promise<void> {
    const rows = await this.#rowsFor(ROOT, 0)
    if (rows.length === 0 && !this.#pending) {
      const empty = document.createElement('div')
      empty.className = 'tree-empty'
      empty.textContent = 'No files yet — press the + button to create one.'
      this.host.replaceChildren(empty)
      return
    }
    this.host.replaceChildren(...rows)
    this.#focusPendingInput()
  }

  async #rowsFor(dir: string, depth: number): Promise<HTMLElement[]> {
    let entries: Entry[] = []
    try {
      entries = await this.fs.readDir(dir)
    } catch {
      return []
    }

    const rows: HTMLElement[] = []
    if (this.#pending && !this.#pending.renaming && this.#pending.parent === dir) {
      rows.push(this.#inputRow(depth))
    }

    for (const entry of entries) {
      if (this.#pending?.renaming === entry.path) {
        rows.push(this.#inputRow(depth, entry.name))
        continue
      }
      rows.push(this.#row(entry, depth))
      if (entry.kind === 'dir' && this.#expanded.has(entry.path)) {
        rows.push(...(await this.#rowsFor(entry.path, depth + 1)))
      }
    }
    return rows
  }

  #row(entry: Entry, depth: number): HTMLElement {
    const row = document.createElement('div')
    row.className = 'row' + (entry.path === this.#selected ? ' selected' : '')
    row.dataset.path = entry.path
    row.dataset.kind = entry.kind
    row.style.paddingLeft = `${depth * 12 + 8}px`
    row.title = entry.path

    const twisty = document.createElement('span')
    twisty.className = 'twisty'
    if (entry.kind === 'dir') {
      twisty.textContent = this.#expanded.has(entry.path) ? '⌄' : '›'
      twisty.classList.add(this.#expanded.has(entry.path) ? 'open' : 'closed')
    }

    const icon = document.createElement('span')
    icon.className = 'icon'
    icon.textContent = entry.kind === 'dir' ? '📁' : fileIcon(entry.name)

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = entry.name

    row.append(twisty, icon, label)
    return row
  }

  #inputRow(depth: number, initial = ''): HTMLElement {
    const row = document.createElement('div')
    row.className = 'row row-input'
    row.style.paddingLeft = `${depth * 12 + 8}px`

    const icon = document.createElement('span')
    icon.className = 'icon'
    icon.textContent = this.#pending?.kind === 'dir' ? '📁' : '📄'

    const input = document.createElement('input')
    input.className = 'name-input'
    input.value = initial
    input.spellcheck = false
    input.setAttribute('aria-label', 'File name')

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.#commitPending(input.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.#pending = null
        void this.refresh()
      }
    })
    // Clicking away is an implicit cancel rather than an implicit create:
    // accidentally making a file named whatever was half-typed is worse than
    // losing a few keystrokes.
    input.addEventListener('blur', () => {
      if (this.#pending) {
        this.#pending = null
        void this.refresh()
      }
    })

    row.append(icon, input)
    return row
  }

  #focusPendingInput(): void {
    const input = this.host.querySelector<HTMLInputElement>('.name-input')
    if (!input) return
    input.focus()
    const dot = input.value.lastIndexOf('.')
    // Select the stem only, so renaming main.py to app.py doesn't require
    // retyping the extension.
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }

  /** Begin creating a file or folder inside `parent` (defaults to the selection). */
  async startCreate(kind: EntryKind, parent?: string): Promise<void> {
    const dir = parent ?? (await this.targetDir())
    this.#expanded.add(dir)
    this.#pending = { parent: dir, kind }
    await this.refresh()
  }

  async startRename(path: string): Promise<void> {
    this.#pending = {
      parent: dirname(path),
      kind: await this.#kindOf(path),
      renaming: path,
    }
    await this.refresh()
  }

  async #commitPending(rawName: string): Promise<void> {
    const pending = this.#pending
    if (!pending) return
    this.#pending = null

    const name = rawName.trim()
    const problem = validateName(name)
    if (problem) {
      if (name) this.handlers.onError(problem)
      await this.refresh()
      return
    }

    const target = join(pending.parent, name)
    try {
      if (pending.renaming) {
        if (pending.renaming === target) {
          await this.refresh()
          return
        }
        if (await this.fs.exists(target)) {
          this.handlers.onError(`${name} already exists`)
          await this.refresh()
          return
        }
        await this.fs.rename(pending.renaming, target)
        await this.handlers.onRenamed(pending.renaming, target)
        this.#selected = target
      } else if (pending.kind === 'dir') {
        if (await this.fs.exists(target)) {
          this.handlers.onError(`${name} already exists`)
          await this.refresh()
          return
        }
        await this.fs.mkdir(target)
        this.#expanded.add(target)
        this.#selected = target
      } else {
        if (await this.fs.exists(target)) {
          this.handlers.onError(`${name} already exists`)
          await this.refresh()
          return
        }
        // A new file is created empty and immediately opened — the point of
        // "new file" is to start typing in it.
        await this.fs.writeFile(target, '')
        this.#selected = target
        await this.refresh()
        await this.handlers.onOpenFile(target)
        return
      }
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err))
    }
    await this.refresh()
  }

  async remove(path: string): Promise<void> {
    const kind = await this.#kindOf(path)
    const what = kind === 'dir' ? 'folder and everything inside it' : 'file'
    if (!confirm(`Delete ${basename(path)}?\n\nThis removes the ${what} permanently.`)) return
    try {
      await this.fs.remove(path)
      this.handlers.onDeleted(path)
      if (this.#selected === path) this.#selected = null
      this.#expanded.delete(path)
      await this.refresh()
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err))
    }
  }

  async select(path: string): Promise<void> {
    this.#selected = path
    // Reveal: every ancestor must be expanded for the row to exist at all.
    const parts = path.split('/').filter(Boolean)
    for (let i = 0; i < parts.length - 1; i++) {
      this.#expanded.add('/' + parts.slice(0, i + 1).join('/'))
    }
    await this.refresh()
  }

  async #onClick(e: MouseEvent): Promise<void> {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row')
    if (!row || row.classList.contains('row-input')) return
    const path = row.dataset.path
    if (!path) return

    this.#selected = path
    if (row.dataset.kind === 'dir') {
      if (this.#expanded.has(path)) this.#expanded.delete(path)
      else this.#expanded.add(path)
      await this.refresh()
    } else {
      await this.refresh()
      await this.handlers.onOpenFile(path)
    }
  }

  #onDoubleClick(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row')
    if (row?.dataset.path && !row.classList.contains('row-input')) {
      this.handlers.onOpenFile(row.dataset.path)
    }
  }

  #onContextMenu(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row')
    const path = row?.dataset.path
    e.preventDefault()
    if (path) this.#selected = path
    void this.refresh()

    const isDir = row?.dataset.kind === 'dir'
    const parent = !path ? ROOT : isDir ? path : dirname(path)

    showMenu(e.clientX, e.clientY, [
      { label: 'New File', run: () => void this.startCreate('file', parent) },
      { label: 'New Folder', run: () => void this.startCreate('dir', parent) },
      ...(path
        ? [
            { label: 'Rename', run: () => void this.startRename(path) },
            { label: 'Delete', run: () => void this.remove(path), danger: true },
          ]
        : []),
    ])
  }
}

interface MenuItem {
  label: string
  run: () => void
  danger?: boolean
}

function showMenu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector('.context-menu')?.remove()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`

  for (const item of items) {
    const button = document.createElement('button')
    button.textContent = item.label
    if (item.danger) button.classList.add('danger')
    button.addEventListener('click', () => {
      menu.remove()
      item.run()
    })
    menu.append(button)
  }
  document.body.append(menu)

  // Nudge back on-screen if the click was near an edge.
  const rect = menu.getBoundingClientRect()
  if (rect.right > innerWidth) menu.style.left = `${innerWidth - rect.width - 4}px`
  if (rect.bottom > innerHeight) menu.style.top = `${innerHeight - rect.height - 4}px`

  const dismiss = (ev: Event) => {
    if (ev.type === 'mousedown' && menu.contains(ev.target as Node)) return
    menu.remove()
    removeEventListener('mousedown', dismiss)
    removeEventListener('resize', dismiss)
    removeEventListener('keydown', onKey)
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') dismiss(ev)
  }
  // Deferred so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    addEventListener('mousedown', dismiss)
    addEventListener('resize', dismiss)
    addEventListener('keydown', onKey)
  })
}

const ICONS: Record<string, string> = {
  '.py': '🐍',
  '.ipynb': '🐍',
  '.js': '🟨',
  '.mjs': '🟨',
  '.cjs': '🟨',
  '.ts': '🟦',
  '.tsx': '🟦',
  '.jsx': '🟨',
  '.json': '🧩',
  '.html': '🌐',
  '.css': '🎨',
  '.md': '📝',
  '.txt': '📄',
  '.yml': '⚙️',
  '.yaml': '⚙️',
  '.sh': '🐚',
  '.sql': '🗄️',
  '.csv': '📊',
}

function fileIcon(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot <= 0 ? '' : name.slice(dot).toLowerCase()
  return ICONS[ext] ?? '📄'
}
