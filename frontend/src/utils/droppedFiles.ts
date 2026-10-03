/**
 * Files from a drop, with dropped folders walked recursively.
 *
 * `dataTransfer.files` lists a dropped folder as one zero-byte entry, so the
 * uploader has to go through `dataTransfer.items` and the FileSystem entry
 * API to reach the files inside. Browsers without `webkitGetAsEntry` keep
 * the plain `files` list.
 *
 * Nested folders are flattened. Inside a folder the entries are sorted by
 * name (`readEntries` hands them back in batches of unspecified order) and
 * hidden entries (`.DS_Store`, `._IMG_0001.jpg`) are skipped. The dropped
 * items themselves are taken as the user chose them.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  // Both lists are emptied once the drop event has returned, so read them
  // synchronously before the first await.
  const plainFiles = Array.from(dataTransfer.files || []);
  const items = Array.from(dataTransfer.items || []);
  if (items.length === 0 || typeof items[0].webkitGetAsEntry !== 'function') {
    return plainFiles;
  }
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return plainFiles;

  const files: File[] = [];
  for (const entry of entries) {
    await walkEntry(entry, files);
  }
  return files;
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    if (file) out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const children = (await readAllEntries((entry as FileSystemDirectoryEntry).createReader()))
    .filter((child) => !child.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const child of children) {
    await walkEntry(child, out);
  }
}

// An entry that cannot be read any more (moved away mid-drop) is skipped.
const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));

// readEntries returns at most ~100 entries per call and an empty batch once
// the directory is exhausted.
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([]))
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}
