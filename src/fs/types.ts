export type EntryKind = 'file' | 'dir'

export interface Entry {
  name: string
  path: string
  kind: EntryKind
}

/**
 * The seam between the editor and wherever bytes actually live.
 *
 * Everything above this interface — tree, tabs, editor — only ever deals in
 * paths and strings. Swapping OPFS for a local-disk or GitHub-backed
 * implementation later means writing one more class, not touching the UI.
 */
export interface FSProvider {
  readDir(path: string): Promise<Entry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  exists(path: string): Promise<boolean>
}
