import * as monaco from 'monaco-editor'
// Specifiers are relative to monaco's `exports` map ("./*" -> "./esm/vs/*.js"),
// so the esm/vs prefix is already applied and must not be repeated here.
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

// Monaco does tokenization for a few languages off the main thread so typing
// never blocks on analysis. Each of those needs a real Worker, and only the
// bundler knows the hashed URL its code ended up at — hence this hook rather
// than a hardcoded path. Python isn't here: its highlighting is a Monarch
// grammar that runs on the main thread, cheaply.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

/**
 * Pick a language id from a filename.
 *
 * Monaco already knows every extension it supports — each language registers
 * its own list — so asking the registry beats maintaining a parallel map that
 * silently drifts.
 */
export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  const ext = dot <= 0 ? '' : name.slice(dot).toLowerCase()

  for (const lang of monaco.languages.getLanguages()) {
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id
    if (lang.filenames?.some((f) => f.toLowerCase() === name.toLowerCase())) return lang.id
  }
  return 'plaintext'
}

/** Languages where tabs are a bug waiting to happen. */
const SPACE_INDENTED = new Set(['python', 'yaml', 'markdown'])

export function createModel(path: string, text: string): monaco.editor.ITextModel {
  const language = languageForPath(path)
  const model = monaco.editor.createModel(text, language, monaco.Uri.parse(`opfs://${path}`))

  // Python's whitespace is syntax, so getting indentation wrong corrupts the
  // program rather than just looking untidy. Prefer what the file already does
  // (so pasted code keeps its own convention) and fall back to 4 spaces.
  if (SPACE_INDENTED.has(language)) {
    model.detectIndentation(true, 4)
  }
  return model
}

export function createEditor(host: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  return monaco.editor.create(host, {
    model: null,
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 13,
    fontFamily:
      "'SF Mono', Menlo, Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    bracketPairColorization: { enabled: true },
    padding: { top: 8 },
    // Left off deliberately: reformatting on paste is the fastest way to
    // destroy pasted Python, since Monaco has no Python formatter and would
    // fall back to generic brace logic.
    formatOnPaste: false,
  })
}

export { monaco }
