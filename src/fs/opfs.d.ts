// OPFS directory iteration is shipped in every browser that supports OPFS but
// is not yet in TypeScript's DOM lib. Declaration merging adds just the members
// we rely on rather than redeclaring the whole handle.
interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  keys(): AsyncIterableIterator<string>
  values(): AsyncIterableIterator<FileSystemHandle>
}
