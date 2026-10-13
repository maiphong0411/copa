import './style.css'
import { monaco } from './editor/monaco'
import { OpfsProvider } from './fs/opfs'
import { basename, ROOT } from './fs/path'
import { FileTree } from './ui/tree'
import { Workspace } from './ui/workspace'
import { lock, requireUnlock } from './ui/lock'

const WELCOME = `# Welcome to copa
#
# This file lives in your browser's private filesystem (OPFS) — not on a
# server, not in this site's repository. Reloading keeps it; clearing site
# data erases it.
#
# Try it: paste some Python below, then press Ctrl+S (Cmd+S on a Mac).


def fib(n: int) -> list[int]:
    """First n Fibonacci numbers."""
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return seq[:n]


if __name__ == "__main__":
    for i, value in enumerate(fib(10)):
        print(f"fib({i}) = {value}")
`

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

// Pulling in @types/node for the Vite config makes setTimeout's return type
// ambiguous between the DOM's number and Node's Timeout; infer it instead.
let toastTimer: ReturnType<typeof setTimeout> | undefined

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const node = el('toast')
  node.textContent = message
  node.className = `toast ${kind}`
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    node.hidden = true
  }, kind === 'error' ? 4000 : 2000)
}

function fatal(message: string): void {
  document.body.innerHTML = `<div class="fatal"><h1>copa can't start</h1><p>${message}</p></div>`
}

async function boot(): Promise<void> {
  await requireUnlock()

  if (!OpfsProvider.isSupported()) {
    fatal(
      'This browser has no Origin Private File System, which is where copa keeps your files. ' +
        'Chrome, Edge, Safari 17+ and Firefox 111+ all support it. Private/incognito windows ' +
        'sometimes disable it.',
    )
    return
  }

  const fs = new OpfsProvider()
  el('app').hidden = false

  // Seed only a genuinely empty workspace — never overwrite real work.
  if ((await fs.readDir(ROOT)).length === 0) {
    await fs.writeFile('/welcome.py', WELCOME)
  }

  const workspace = new Workspace(fs, {
    editorHost: el('editor-host'),
    tabBar: el('tabs'),
    placeholder: el('placeholder'),
  })

  const tree = new FileTree(fs, el('tree'), {
    onOpenFile: async (path) => {
      try {
        await workspace.open(path)
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    },
    onDeleted: (path) => workspace.closeUnder(path),
    onRenamed: (from, to) => workspace.relocate(from, to),
    onError: (message) => toast(message, 'error'),
  })

  await tree.refresh()

  // ---- status bar -------------------------------------------------------

  const statusPath = el('status-path')
  const statusSave = el('status-save')
  const statusPos = el('status-pos')
  const statusIndent = el('status-indent')
  const statusLang = el('status-lang')

  function renderStatus(): void {
    const path = workspace.activePath
    if (!path) {
      statusPath.textContent = 'No file open'
      statusSave.textContent = ''
      statusPos.textContent = ''
      statusIndent.textContent = ''
      statusLang.textContent = ''
      document.title = 'copa'
      return
    }
    const model = workspace.editor.getModel()
    const dirty = workspace.isDirty(path)
    const position = workspace.editor.getPosition()
    const options = model?.getOptions()

    statusPath.textContent = path
    statusSave.textContent = dirty ? 'Unsaved' : 'Saved'
    statusSave.classList.toggle('warn', dirty)
    statusPos.textContent = position ? `Ln ${position.lineNumber}, Col ${position.column}` : ''
    statusIndent.textContent = options
      ? options.insertSpaces
        ? `Spaces: ${options.tabSize}`
        : `Tab size: ${options.tabSize}`
      : ''
    statusLang.textContent = model ? model.getLanguageId() : ''
    document.title = `${dirty ? '● ' : ''}${basename(path)} — copa`
  }

  workspace.onDidChange = renderStatus
  workspace.editor.onDidChangeCursorPosition(renderStatus)
  renderStatus()

  // ---- toolbar ----------------------------------------------------------

  el('btn-new-file').addEventListener('click', () => void tree.startCreate('file'))
  el('btn-new-folder').addEventListener('click', () => void tree.startCreate('dir'))
  el('btn-refresh').addEventListener('click', () => void tree.refresh())
  el('btn-lock').addEventListener('click', () => {
    if (workspace.hasUnsaved && !confirm('You have unsaved changes. Lock anyway?')) return
    lock()
  })

  // Downloading is the bridge out of OPFS: the browser's private filesystem is
  // invisible to the OS, so an anchor with a blob URL is the only way to get a
  // file onto real disk without a backend.
  el('btn-download').addEventListener('click', () => {
    const path = workspace.activePath
    const model = workspace.editor.getModel()
    if (!path || !model) {
      toast('Open a file first', 'error')
      return
    }
    const blob = new Blob([model.getValue()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = basename(path)
    anchor.click()
    URL.revokeObjectURL(url)
  })

  // ---- global keys ------------------------------------------------------

  // Monaco binds Ctrl+S itself, but only while the editor has focus. This
  // catches the same chord from the tree or the toolbar, and stops the browser
  // from offering to save the page.
  addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return

    if (e.key.toLowerCase() === 's') {
      e.preventDefault()
      void workspace.saveAll().then(() => {
        if (workspace.activePath) toast(`Saved ${basename(workspace.activePath)}`)
      })
    } else if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
      e.preventDefault()
      void tree.startCreate('file')
    }
  })

  // The browser will only show its generic "leave site?" dialog — the text is
  // not ours to choose — but it does stop an accidental reload from discarding
  // edits that were never written to OPFS.
  addEventListener('beforeunload', (e) => {
    if (workspace.hasUnsaved) e.preventDefault()
  })

  // Dropping a file in reads it into the workspace. FileReader works on any
  // File object, so this needs no permissions at all.
  const main = el('main')
  main.addEventListener('dragover', (e) => {
    e.preventDefault()
    main.classList.add('drop-target')
  })
  main.addEventListener('dragleave', () => main.classList.remove('drop-target'))
  main.addEventListener('drop', (e) => {
    e.preventDefault()
    main.classList.remove('drop-target')
    void (async () => {
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      const dir = await tree.targetDir()
      let last = ''
      for (const file of files) {
        last = `${dir === ROOT ? '' : dir}/${file.name}`
        await fs.writeFile(last, await file.text())
      }
      await tree.refresh()
      if (files.length === 1) {
        await tree.select(last)
        await workspace.open(last)
      }
      toast(`Imported ${files.length} file${files.length > 1 ? 's' : ''}`)
    })()
  })

  if (await fs.exists('/welcome.py')) {
    await tree.select('/welcome.py')
    await workspace.open('/welcome.py')
  }

  // Monaco computes its layout from the host's size, which is zero while the
  // app is hidden behind the lock screen.
  monaco.editor.remeasureFonts()
  workspace.editor.layout()
}

boot().catch((err: unknown) => {
  fatal(err instanceof Error ? err.message : String(err))
})
