/**
 * Gallery folders (#1160).
 *
 * A category has always been a FILTER: its photos stay in the root grid and
 * picking the category narrows that grid. A category flagged `is_folder` is a
 * CONTAINER instead — its photos are absent from the root grid entirely and only
 * render once the guest opens the folder.
 *
 * Since issue 1786 folders nest (up to three levels, `parent_id`) and a photo's
 * folder has its own slot, `folder_id`; `category_id` is a filter only. The
 * backend returns every folder that holds photos plus all its ancestors, so a
 * parent that only holds subfolders still gets a tile.
 *
 * Kept as pure functions so the containment rule is unit-testable without
 * mounting the gallery, and so every layout shares one definition of "what is
 * visible right now".
 *
 * NOTE: folders are organisational, not access control. A foldered photo is
 * still served by the same per-photo auth as any other; hiding it from the root
 * grid does not make its URL unreachable.
 */
import type { Photo, PhotoCategory } from '../../types';

export const FOLDER_QUERY_PARAM = 'folder';

/**
 * Server-side cap on `/download-selected` and `/download-jobs`
 * (gallery/downloads.js refuses a longer id list). Mirrored here so the folder
 * download sends what the server takes and says so, instead of promising the
 * whole folder.
 */
export const SELECTED_DOWNLOAD_LIMIT = 500;

/** Ids of every category that contains (rather than filters) its photos. */
export function folderCategoryIds(categories: PhotoCategory[] | undefined): Set<number | string> {
  const ids = new Set<number | string>();
  (categories || []).forEach((c) => {
    if (c.is_folder) ids.add(c.id);
  });
  return ids;
}

/**
 * The URL key for a folder.
 *
 * Prefers the slug because it makes a shared link readable, but falls back to
 * the id: `adminCategories` derives slugs with `[^\w\s-]` stripping, and `\w`
 * is ASCII-only, so a perfectly valid name in a non-Latin script ("Избранное",
 * "日本語") slugs to the empty string. An empty key would delete the query
 * param on open and never resolve on read — the folder's photos would be gone
 * from the root grid with no way back to them.
 */
export function folderKey(category: Pick<PhotoCategory, 'id' | 'slug'>): string {
  const slug = (category.slug || '').trim();
  // The id is always appended: slugs are only unique per scope
  // (UNIQUE(slug, event_id)), so a global folder and an event folder can share
  // one. Keying on the slug alone made the second of the pair unopenable —
  // every lookup resolved to the first match.
  return slug ? `${slug}-${category.id}` : String(category.id);
}

/**
 * The folder matching a `?folder=<key>`, or null at root / for an unknown key.
 * Any depth: a nested folder is just a deeper id (issue 1786).
 *
 * Resolves on the trailing ID rather than the whole key: renaming a category
 * rewrites its slug, so an already-shared `?folder=selects-11` would otherwise
 * stop matching and silently dump the visitor at the gallery root. The slug is
 * there to make the link readable, not to identify the folder.
 */
export function findFolderByKey(
  categories: PhotoCategory[] | undefined,
  key: string | null
): PhotoCategory | null {
  if (!key) return null;
  const list = categories || [];

  const trailing = key.split('-').pop();
  const id = trailing !== undefined && trailing !== '' ? Number(trailing) : NaN;
  if (Number.isInteger(id)) {
    const byId = list.find((c) => c.is_folder && Number(c.id) === id);
    if (byId) return byId;
  }

  return list.find((c) => c.is_folder && folderKey(c) === key) || null;
}

/** The view switch (issue 1786): "Folders" (containment on) or "All photos". */
export const VIEW_QUERY_PARAM = 'view';
export type GalleryViewMode = 'folders' | 'all';

/**
 * Deepest folder nesting the backend allows (issue 1786). Only a guard against
 * a malformed parent chain looping forever here; the backend enforces it.
 */
const MAX_FOLDER_DEPTH = 3;

const idKey = (id: number | string | null | undefined): string | null =>
  id === null || id === undefined || id === '' ? null : String(id);

// Folder names come from directory names on ingest ("Day 2", "Day 10"), so a
// plain string sort would put "Day 10" first. The backend leaves sibling order
// to the client.
const folderCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The folder a photo lives in, or null for the gallery root.
 *
 * Since issue 1786 that is `folder_id`; `category_id` is a filter only. A
 * payload without the field at all (an older backend) still carries the issue
 * 1160 shape, where a folder was a category flagged `is_folder` — read that so
 * a frontend ahead of its backend keeps the folders working. A folder id that
 * is not among the returned folders falls back to root: the photo would
 * otherwise be unreachable.
 */
export function photoFolderId(
  photo: Pick<Photo, 'folder_id' | 'category_id'>,
  folderIds: Set<string>
): string | null {
  const raw = photo.folder_id !== undefined ? photo.folder_id : photo.category_id;
  const key = idKey(raw);
  return key !== null && folderIds.has(key) ? key : null;
}

function folderIdKeys(categories: PhotoCategory[] | undefined): Set<string> {
  return new Set([...folderCategoryIds(categories)].map(String));
}

/** Folders by id, plus each folder's EFFECTIVE parent (null for top level). */
function folderIndex(categories: PhotoCategory[] | undefined) {
  const byId = new Map<string, PhotoCategory>();
  (categories || []).forEach((c) => {
    if (c.is_folder) byId.set(String(c.id), c);
  });
  // A parent missing from the payload would strand its children (and their
  // photos) out of reach — hang them off the root instead.
  const parentOf = (folder: PhotoCategory): string | null => {
    const parent = idKey(folder.parent_id);
    return parent !== null && parent !== String(folder.id) && byId.has(parent) ? parent : null;
  };
  return { byId, parentOf };
}

/** Direct child folders of `parentId` (null = top level), sorted naturally by name. */
export function childFolders(
  categories: PhotoCategory[] | undefined,
  parentId: number | string | null
): PhotoCategory[] {
  const { byId, parentOf } = folderIndex(categories);
  const wanted = idKey(parentId);
  return [...byId.values()]
    .filter((folder) => parentOf(folder) === wanted)
    .sort((a, b) => folderCollator.compare(a.name, b.name));
}

/**
 * The breadcrumb trail for a folder: top-level folder first, the folder itself
 * last. Empty for root or an unknown id.
 */
export function folderAncestors(
  categories: PhotoCategory[] | undefined,
  folderId: number | string | null
): PhotoCategory[] {
  const { byId, parentOf } = folderIndex(categories);
  const trail: PhotoCategory[] = [];
  let current = idKey(folderId);
  // Bounded walk: a malformed parent chain (a cycle) must not hang the page.
  while (current !== null && trail.length <= MAX_FOLDER_DEPTH * 2) {
    const folder = byId.get(current);
    if (!folder || trail.includes(folder)) break;
    trail.unshift(folder);
    current = parentOf(folder);
  }
  return trail;
}

/** Ids of a folder and every folder below it, as strings. */
export function folderSubtreeIds(
  categories: PhotoCategory[] | undefined,
  folderId: number | string
): Set<string> {
  const { byId, parentOf } = folderIndex(categories);
  const children = new Map<string, string[]>();
  byId.forEach((folder, id) => {
    const parent = parentOf(folder);
    if (parent !== null) children.set(parent, [...(children.get(parent) || []), id]);
  });
  const root = String(folderId);
  const ids = new Set<string>();
  const queue = byId.has(root) ? [root] : [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (ids.has(id)) continue;
    ids.add(id);
    queue.push(...(children.get(id) || []));
  }
  return ids;
}

/**
 * The photos in scope right now.
 *
 * Root: only photos that live in no folder. Inside a folder: only the photos
 * DIRECTLY in it — its subfolders get tiles of their own (issue 1786).
 */
export function photosInScope(
  photos: Photo[] | undefined,
  categories: PhotoCategory[] | undefined,
  openFolderId: number | string | null
): Photo[] {
  const list = photos || [];
  const folders = folderIdKeys(categories);
  // Always a NEW array, even on the no-folders fast path: callers sort the
  // result in place, and handing back `data.photos` itself would sort the React
  // Query cache and reorder it for every other consumer.
  if (folders.size === 0) return openFolderId === null || openFolderId === undefined ? [...list] : [];
  const wanted = idKey(openFolderId);
  return list.filter((p) => photoFolderId(p, folders) === wanted);
}

/**
 * Photos for the current view: the folder scope, or every photo in "All
 * photos" mode (issue 1786), where containment is off. Filter categories still
 * apply on top in both.
 */
export function photosInView(
  photos: Photo[] | undefined,
  categories: PhotoCategory[] | undefined,
  openFolderId: number | string | null,
  viewAll: boolean
): Photo[] {
  return viewAll ? [...(photos || [])] : photosInScope(photos, categories, openFolderId);
}

/** Every photo in a folder and its subfolders — what "Download folder" sends. */
export function photosInSubtree(
  photos: Photo[] | undefined,
  categories: PhotoCategory[] | undefined,
  folderId: number | string
): Photo[] {
  const folders = folderIdKeys(categories);
  const subtree = folderSubtreeIds(categories, folderId);
  return (photos || []).filter((p) => {
    const id = photoFolderId(p, folders);
    return id !== null && subtree.has(id);
  });
}

export interface FolderTile {
  category: PhotoCategory;
  /** Photos in the folder and all its subfolders. */
  count: number;
  /** Direct subfolders that hold photos. */
  subfolderCount: number;
  coverPhoto: Photo | null;
}

/**
 * Tiles for the child folders of `parentId` (null = root), sorted naturally.
 *
 * Counts are recursive, so "Saturday · 113" is what opening it eventually
 * shows. Only folders that hold photos somewhere below get a tile — an empty
 * folder would be a dead end for a guest. The cover is the category hero (#163)
 * when it is still in the subtree, else the subtree's first photo in the order
 * `photos` arrives in.
 */
export function folderTiles(
  categories: PhotoCategory[] | undefined,
  photos: Photo[] | undefined,
  parentId: number | string | null = null
): FolderTile[] {
  const folders = folderIdKeys(categories);
  const index = folderIndex(categories);
  const children = childFolders(categories, parentId);
  if (children.length === 0) return [];

  // One pass over the photos: map every folder in a child's subtree to that
  // child, then bucket each photo once.
  const owner = new Map<string, string>();
  const subfolderOf = new Map<string, PhotoCategory[]>();
  children.forEach((child) => {
    const id = String(child.id);
    folderSubtreeIds(categories, id).forEach((sub) => owner.set(sub, id));
    subfolderOf.set(id, childFolders(categories, id));
  });
  const contents = new Map<string, Photo[]>();
  (photos || []).forEach((photo) => {
    const folderId = photoFolderId(photo, folders);
    const tileId = folderId !== null ? owner.get(folderId) : undefined;
    if (tileId === undefined) return;
    const bucket = contents.get(tileId);
    if (bucket) bucket.push(photo);
    else contents.set(tileId, [photo]);
  });
  // Which folders hold photos anywhere below, for the subfolder count.
  const nonEmpty = new Set<string>();
  (photos || []).forEach((photo) => {
    let id = photoFolderId(photo, folders);
    const { byId, parentOf } = index;
    let guard = 0;
    while (id !== null && !nonEmpty.has(id) && guard++ <= MAX_FOLDER_DEPTH * 2) {
      nonEmpty.add(id);
      const folder = byId.get(id);
      id = folder ? parentOf(folder) : null;
    }
  });

  return children
    .map((category) => {
      const id = String(category.id);
      const inside = contents.get(id) || [];
      const hero = category.hero_photo_id
        ? inside.find((p) => p.id === category.hero_photo_id) || null
        : null;
      return {
        category,
        count: inside.length,
        subfolderCount: (subfolderOf.get(id) || []).filter((sub) => nonEmpty.has(String(sub.id))).length,
        coverPhoto: hero || inside[0] || null,
      };
    })
    .filter((tile) => tile.count > 0);
}

export interface FolderTreeNode {
  category: PhotoCategory;
  /** Recursive photo count. */
  count: number;
  children: FolderTreeNode[];
}

/** The whole folder tree with recursive counts, for the sidebar (issue 1786). */
export function folderTree(
  categories: PhotoCategory[] | undefined,
  photos: Photo[] | undefined,
  parentId: number | string | null = null,
  depth = 0
): FolderTreeNode[] {
  if (depth > MAX_FOLDER_DEPTH * 2) return [];
  return folderTiles(categories, photos, parentId).map((tile) => ({
    category: tile.category,
    count: tile.count,
    children: tile.subfolderCount > 0
      ? folderTree(categories, photos, tile.category.id, depth + 1)
      : [],
  }));
}

/**
 * People, recounted against the photos actually on screen (#1160).
 *
 * `face_count` comes from /people and spans the whole event, which contradicts
 * the grid once folders exist: inside a folder a face reads "12 photos" but
 * clicking it yields only the ones in that folder, and at root a person whose
 * photos ALL live in a folder shows up and filters down to nothing — a dead
 * chip. Recomputing from `photo.person_ids` (already what the filter itself
 * uses) keeps the strip honest, and dropping the zeroes removes the dead chips.
 */
export function peopleInScope<T extends { id: number; face_count: number }>(
  people: T[] | undefined,
  scopedPhotos: Photo[] | undefined
): T[] {
  const list = people || [];
  if (list.length === 0) return list;

  const counts = new Map<number, number>();
  (scopedPhotos || []).forEach((photo) => {
    const ids = (photo as Photo & { person_ids?: number[] }).person_ids || [];
    ids.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
  });

  // Re-sorted, not just recounted: /people orders by the EVENT-wide count, and
  // PeopleStrip only shows the first 12 inline. Keeping that order after
  // rescoping can push the folder's most-photographed person behind "Show all".
  return list
    .map((person) => ({ ...person, face_count: counts.get(person.id) || 0 }))
    .filter((person) => person.face_count > 0)
    .sort((a, b) => b.face_count - a.face_count);
}

/** Categories that still act as filters — the only ones the filter UI should offer. */
export function filterCategories(categories: PhotoCategory[] | undefined): PhotoCategory[] {
  return (categories || []).filter((c) => !c.is_folder);
}

/** Read the open folder slug from the address bar. */
export function readFolderParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(FOLDER_QUERY_PARAM);
}

/**
 * Reflect the open folder in the address bar so a folder is linkable and the
 * back button leaves it. Preserves every other param — `token` and
 * `admin_preview` (#868) both ride on gallery URLs.
 *
 * `replace` rewrites the current entry instead of pushing one: a `?photo=`
 * deep link into a folder (photoLink.ts) switches folders on arrival, and a
 * pushed entry there would make Back reopen the root the visitor never saw.
 */
export function writeFolderParam(slug: string | null, { replace = false } = {}): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (slug) {
    url.searchParams.set(FOLDER_QUERY_PARAM, slug);
  } else {
    url.searchParams.delete(FOLDER_QUERY_PARAM);
  }
  // Opening a folder is folder navigation, so it leaves "All photos".
  url.searchParams.delete(VIEW_QUERY_PARAM);
  writeHistory({ [FOLDER_QUERY_PARAM]: slug }, url, replace);
}

function writeHistory(state: Record<string, unknown>, url: URL, replace: boolean): void {
  if (replace) {
    window.history.replaceState(state, '', url.toString());
  } else {
    window.history.pushState(state, '', url.toString());
  }
}

/** Read the view switch from the address bar; anything but `all` is folders. */
export function readViewParam(): GalleryViewMode {
  if (typeof window === 'undefined') return 'folders';
  return new URLSearchParams(window.location.search).get(VIEW_QUERY_PARAM) === 'all' ? 'all' : 'folders';
}

/**
 * Reflect the view switch in the address bar (issue 1786), as `?view=all`, so
 * "All photos" is linkable and Back returns to the folders. Switching views
 * always lands at the root: "All photos" has no open folder, and coming back
 * to folders starts from the top rather than a folder the guest left earlier.
 */
export function writeViewParam(view: GalleryViewMode, { replace = false } = {}): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (view === 'all') {
    url.searchParams.set(VIEW_QUERY_PARAM, 'all');
  } else {
    url.searchParams.delete(VIEW_QUERY_PARAM);
  }
  url.searchParams.delete(FOLDER_QUERY_PARAM);
  writeHistory({ [VIEW_QUERY_PARAM]: view }, url, replace);
}
