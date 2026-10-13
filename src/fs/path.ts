// Paths are POSIX-style and always absolute: '/', '/src', '/src/main.py'.
// OPFS itself has no concept of a path — it only hands out directory handles
// you walk one segment at a time — so this module is what lets the rest of the
// app speak in paths and resolve them at the last moment.

export const ROOT = '/'

export function split(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function normalize(path: string): string {
  const parts: string[] = []
  for (const seg of split(path)) {
    if (seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

export function join(dir: string, name: string): string {
  return normalize(`${dir}/${name}`)
}

export function dirname(path: string): string {
  const parts = split(path)
  parts.pop()
  return '/' + parts.join('/')
}

export function basename(path: string): string {
  return split(path).pop() ?? ''
}

export function extname(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

export function isRoot(path: string): boolean {
  return normalize(path) === ROOT
}

/** True when `path` is `dir` itself or lives underneath it. */
export function isInside(dir: string, path: string): boolean {
  const d = normalize(dir)
  const p = normalize(path)
  if (d === ROOT) return true
  return p === d || p.startsWith(d + '/')
}

const INVALID = /[\\/:*?"<>|]/

/** Returns an error message, or null when the name is usable. */
export function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name cannot be empty'
  if (trimmed === '.' || trimmed === '..') return 'Reserved name'
  if (INVALID.test(trimmed)) return 'Name cannot contain \\ / : * ? " < > |'
  return null
}
