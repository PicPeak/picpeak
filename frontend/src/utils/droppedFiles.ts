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
 * whole archive is not turned into File objects before the uploader's cap
 * truncates the result. It is a ceiling for the walk, not the cap: pass a
 * value that does not depend on the selection at drop time, since that can
 * change while the walk is pending. Only files passing `accept` are
 * collected and counted, so sidecars and oversized files inside the folder
 * do not use up the budget.
 *
 * A directory's entry list is always drained and sorted as a whole — names
 * only, which is cheap — because `readEntries` batches come in unspecified
 * order and stopping between them could drop a name that sorts first. What
 * the limit bounds is the expensive part: resolving `entry.file()` and
 * recursing into subfolders, both done in sorted order until it is reached.
 * Plain files (no entry API) are returned unfiltered; the caller filters.
 *
 * Rejected files do not count toward `limit`, so a tree of nothing but
 * unsupported files would still resolve every one of them. A second budget
 * bounds the files examined: EXAMINED_PER_COLLECTED times the limit, enough
 * for RAW + sidecar + JPEG sets several times over. The walk stops when
 * either budget is spent. When it is the examined budget that ends the walk
 * with entries still unread, `onTruncated` is called once, so the caller can
 * say so instead of omitting files silently (running into `limit` is the
 * caller's own cap and has its own notice).
 */
export const EXAMINED_PER_COLLECTED = 5;

export interface CollectOptions {
  limit?: number;
  accept?: (file: File) => boolean;
  onTruncated?: () => void;
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

  const walk: Walk = {
    out: [], limit, accept, examined: 0, maxExamined: limit * EXAMINED_PER_COLLECTED, truncated: false,
  };
  for (const entry of entries) {
    await walkEntry(entry, walk);
  }
  if (walk.truncated) options.onTruncated?.();
  return walk.out;
}

interface Walk {
  out: File[];
  limit: number;
  accept: (file: File) => boolean;
  examined: number;
  maxExamined: number;
  truncated: boolean;
}

// Called with an entry still to be walked: true once either budget is spent.
// Running out of the examined budget short of the limit is what leaves
// entries unread without the caller's cap being the reason.
const spent = (walk: Walk) => {
  if (walk.out.length >= walk.limit) return true;
  if (walk.examined < walk.maxExamined) return false;
  walk.truncated = true;
  return true;
};

async function walkEntry(entry: FileSystemEntry, walk: Walk): Promise<void> {
  if (spent(walk)) return;
  if (entry.isFile) {
    walk.examined += 1;
    const file = await fileOf(entry as FileSystemFileEntry);
    if (file && walk.accept(file)) walk.out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const children = (await readAllEntries((entry as FileSystemDirectoryEntry).createReader()))
    .filter((child) => !child.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const child of children) {
    if (spent(walk)) return;
    await walkEntry(child, walk);
  }
}

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

// An entry that cannot be read any more (moved away mid-drop) is skipped.
const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));
