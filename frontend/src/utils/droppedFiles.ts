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
 *
 * `limit` stops the walk once that many files are collected, so a drop of a
 * whole archive does not read every entry of it before the uploader's cap
 * truncates the result. Pass the remaining capacity plus one: the extra
 * file lets the uploader still raise its "some files skipped" notice. Only
 * files passing `accept` are collected and counted, so sidecars and
 * oversized files inside the folder do not use up the budget. Directories
 * are read batch by batch and the walk stops between batches once the limit
 * is reached, so a flat folder of thousands of entries is not drained first.
 * Plain files (no entry API) are returned unfiltered; the caller filters.
 */
export interface CollectOptions {
  limit?: number;
  accept?: (file: File) => boolean;
}

export async function collectDroppedFiles(
  dataTransfer: DataTransfer,
  options: CollectOptions = {},
): Promise<File[]> {
  const limit = options.limit ?? Infinity;
  const accept = options.accept ?? (() => true);
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

  const walk = { out: [] as File[], limit, accept };
  for (const entry of entries) {
    if (walk.out.length >= limit) break;
    await walkEntry(entry, walk);
  }
  return walk.out;
}

interface Walk {
  out: File[];
  limit: number;
  accept: (file: File) => boolean;
}

async function walkEntry(entry: FileSystemEntry, walk: Walk): Promise<void> {
  if (walk.out.length >= walk.limit) return;
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    if (file && walk.accept(file)) walk.out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  // readEntries returns at most ~100 entries per call and an empty batch once
  // the directory is exhausted. Each batch is sorted and walked on its own,
  // so the walk can stop before the next read.
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    if (walk.out.length >= walk.limit) return;
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([]))
    );
    if (batch.length === 0) return;
    const children = batch
      .filter((child) => !child.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const child of children) {
      if (walk.out.length >= walk.limit) return;
      await walkEntry(child, walk);
    }
  }
}

// An entry that cannot be read any more (moved away mid-drop) is skipped.
const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));
