/**
 * Files from a drop, with dropped folders walked recursively.
 *
 * `dataTransfer.files` lists a dropped folder as one zero-byte entry, so the
 * uploader has to go through `dataTransfer.items` and the FileSystem entry
 * API to reach the files inside. Browsers without `webkitGetAsEntry` keep
 * the plain `files` list.
 *
 * `collectDroppedEntries` keeps each file's directory relative to the drop
 * (issue 1786): `shoot/Friday` for `shoot/Friday/IMG_1.jpg` when the folder
 * `shoot` was dropped, '' for a loose file. That is `entry.fullPath` without
 * the leading slash and the file name, built from the names on the way down
 * so it does not depend on how a browser fills fullPath. The upload maps
 * those directories to gallery folders; `collectDroppedFiles` is the flat
 * list for callers that do not care.
 *
 * Inside a folder the entries are sorted by
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
 * do not use up the budget. It is told how deep the file sits: depth 0 is an
 * item the user dropped by hand, anything above it was found inside a folder,
 * which is the difference between a rejection worth naming and one that is
 * just noise.
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

/** A picked or dropped file with its directory relative to the drop or pick root. */
export interface PickedFile {
  file: File;
  /** '' for a file that was not inside a folder. */
  dir: string;
}

/** Directory part of a relative path: `a/b/c.jpg` → `a/b`, `c.jpg` → ''. */
export const directoryOf = (relativePath: string): string => {
  const cut = relativePath.lastIndexOf('/');
  return cut <= 0 ? '' : relativePath.slice(0, cut).replace(/^\/+/, '');
};

/**
 * Files from `<input type="file">`. A folder pick (`webkitdirectory`) fills
 * `webkitRelativePath` (`Export/Friday/IMG_1.jpg`); a plain pick leaves it
 * empty, so those files are loose.
 */
export const pickedFromInput = (files: File[]): PickedFile[] =>
  files
    .map((file) => ({ file, rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || '' }))
    // A folder pick hands over hidden files too (`._IMG_0001.jpg` AppleDouble
    // files on every exFAT card, `.DS_Store`, anything under `.thumbnails/`);
    // skip them as the drop walk does. A plain pick is taken as chosen.
    .filter(({ rel }) => !rel || !rel.split('/').some((part) => part.startsWith('.')))
    // A folder pick arrives in the file system's order, which is none in
    // particular; sort it as the drop walk does (by name, level by level), so
    // the per-upload cap cuts the same tail either way. Plain picks have no
    // path and stay as chosen.
    .sort((a, b) => (a.rel && b.rel ? comparePaths(a.rel, b.rel) : 0))
    .map(({ file, rel }) => ({ file, dir: directoryOf(rel) }));

// One collator for every name comparison: `localeCompare` with options sets
// up collation anew on each call, which for a pick of tens of thousands of
// files is seconds of blocked main thread before the cap cuts it to hundreds.
const byName = new Intl.Collator(undefined, { numeric: true });

// Names the collator calls equal can still be different entries (`1` and
// `01`, or one name in two Unicode normal forms); code-unit order settles
// those, so two such folders are never interleaved and a pick and a drop of
// the same tree agree on the order.
const compareNames = (a: string, b: string): number => {
  const order = byName.compare(a, b);
  if (order !== 0 || a === b) return order;
  return a < b ? -1 : 1;
};

const comparePaths = (a: string, b: string): number => {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; i < Math.min(as.length, bs.length); i += 1) {
    const order = compareNames(as[i], bs[i]);
    if (order !== 0) return order;
  }
  return as.length - bs.length;
};

export interface CollectOptions {
  limit?: number;
  accept?: (file: File, depth: number) => boolean;
  onTruncated?: () => void;
}

export async function collectDroppedFiles(
  dataTransfer: DataTransfer,
  options: CollectOptions = {},
): Promise<File[]> {
  return (await collectDroppedEntries(dataTransfer, options)).map((picked) => picked.file);
}

export async function collectDroppedEntries(
  dataTransfer: DataTransfer,
  options: CollectOptions = {},
): Promise<PickedFile[]> {
  const limit = options.limit ?? Infinity;
  const accept = options.accept ?? (() => true);
  // Both lists are emptied once the drop event has returned, so read them
  // synchronously before the first await.
  const plainFiles = Array.from(dataTransfer.files || []);
  const items = Array.from(dataTransfer.items || []);
  const loose = () => plainFiles.map((file) => ({ file, dir: '' }));
  if (items.length === 0 || typeof items[0].webkitGetAsEntry !== 'function') {
    return loose();
  }
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return loose();

  const walk: Walk = {
    out: [], limit, accept, examined: 0, maxExamined: limit * EXAMINED_PER_COLLECTED, truncated: false,
  };
  for (const entry of entries) {
    await walkEntry(entry, '', walk, 0);
  }
  if (walk.truncated) options.onTruncated?.();
  return walk.out;
}

interface Walk {
  out: PickedFile[];
  limit: number;
  accept: (file: File, depth: number) => boolean;
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

// `dir` is the directory the entry sits in, relative to the drop; `depth` is
// 0 for an item dropped by hand (see `accept`).
async function walkEntry(entry: FileSystemEntry, dir: string, walk: Walk, depth: number): Promise<void> {
  if (spent(walk)) return;
  if (entry.isFile) {
    walk.examined += 1;
    const file = await fileOf(entry as FileSystemFileEntry);
    if (file && walk.accept(file, depth)) walk.out.push({ file, dir });
    return;
  }
  if (!entry.isDirectory) return;
  const children = (await readAllEntries((entry as FileSystemDirectoryEntry).createReader()))
    .filter((child) => !child.name.startsWith('.'))
    .sort((a, b) => compareNames(a.name, b.name));
  const childDir = dir ? `${dir}/${entry.name}` : entry.name;
  for (const child of children) {
    if (spent(walk)) return;
    await walkEntry(child, childDir, walk, depth + 1);
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
