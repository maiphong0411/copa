import type { Entry, FSProvider } from './types'
import { basename, dirname, isRoot, join, split } from './path'

/**
 * Origin Private File System backend.
 *
 * OPFS is a real, persistent filesystem the browser gives each origin, stored
 * outside the user's visible directories. It survives reloads and restarts and
 * needs no permission prompt, which is exactly why it fits a static site: there
 * is no server to hold state, so the tab holds it instead.
 *
 * The tradeoff bought with "no prompt, no backend": the files are invisible to
 * the OS, scoped to this origin, and the browser may evict them under storage
 * pressure. Import/export is the escape hatch.
 */
export class OpfsProvider implements FSProvider {
  #rootPromise: Promise<FileSystemDirectoryHandle> | null = null

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
  }

  #root(): Promise<FileSystemDirectoryHandle> {
    this.#rootPromise ??= navigator.storage.getDirectory()
    return this.#rootPromise
  }

  /** Walk a path down to its directory handle, creating segments on request. */
  async #dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let handle = await this.#root()
    for (const seg of split(path)) {
      handle = await handle.getDirectoryHandle(seg, { create })
    }
    return handle
  }

  async #file(path: string, create = false): Promise<FileSystemFileHandle> {
    const parent = await this.#dir(dirname(path), create)
    return parent.getFileHandle(basename(path), { create })
  }

  async readDir(path: string): Promise<Entry[]> {
    const dir = await this.#dir(path)
    const entries: Entry[] = []
    for await (const [name, handle] of dir.entries()) {
      entries.push({
        name,
        path: join(path, name),
        kind: handle.kind === 'directory' ? 'dir' : 'file',
      })
    }
    // Directories first, then case-insensitive by name — the ordering VS Code
    // uses, and the one that makes a tree scannable.
    return entries.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === 'dir'
          ? -1
          : 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }

  async readFile(path: string): Promise<string> {
    const handle = await this.#file(path)
    return (await handle.getFile()).text()
  }

  async writeFile(path: string, text: string): Promise<void> {
    const handle = await this.#file(path, true)
    const writable = await handle.createWritable()
    try {
      await writable.write(text)
    } finally {
      // close() is what actually commits the swap file over the original, so
      // it has to run even if write() threw — otherwise the handle leaks and
      // the file is left locked.
      await writable.close()
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.#dir(path, true)
  }

  async remove(path: string): Promise<void> {
    if (isRoot(path)) throw new Error('Cannot delete the workspace root')
    const parent = await this.#dir(dirname(path))
    await parent.removeEntry(basename(path), { recursive: true })
  }

  async rename(from: string, to: string): Promise<void> {
    const kind = await this.statKind(from)
    if (kind === 'file') {
      const text = await this.readFile(from)
      await this.writeFile(to, text)
    } else {
      await this.#copyDir(from, to)
    }
    await this.remove(from)
  }

  async #copyDir(from: string, to: string): Promise<void> {
    await this.mkdir(to)
    for (const entry of await this.readDir(from)) {
      const target = join(to, entry.name)
      if (entry.kind === 'dir') await this.#copyDir(entry.path, target)
      else await this.writeFile(target, await this.readFile(entry.path))
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.statKind(path)) !== null
  }

  /** 'file' | 'dir' | null — OPFS has no stat(), so this probes both lookups. */
  async statKind(path: string): Promise<'file' | 'dir' | null> {
    if (isRoot(path)) return 'dir'
    let parent: FileSystemDirectoryHandle
    try {
      parent = await this.#dir(dirname(path))
    } catch {
      return null
    }
    const name = basename(path)
    try {
      await parent.getFileHandle(name)
      return 'file'
    } catch {
      /* not a file; fall through */
    }
    try {
      await parent.getDirectoryHandle(name)
      return 'dir'
    } catch {
      return null
    }
  }

  /** Every file path under `path`, depth-first. Used by the zip-less export. */
  async walk(path = '/'): Promise<string[]> {
    const out: string[] = []
    for (const entry of await this.readDir(path)) {
      if (entry.kind === 'dir') out.push(...(await this.walk(entry.path)))
      else out.push(entry.path)
    }
    return out
  }
}
