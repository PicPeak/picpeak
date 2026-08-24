/**
 * Gallery folders (#1160).
 *
 * A category has always been a FILTER: its photos stay in the root grid and
 * picking the category narrows that grid. A category flagged `is_folder` is a
 * CONTAINER instead — its photos are absent from the root grid entirely and only
 * render once the guest opens the folder.
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

/** The folder matching a `?folder=<key>`, or null at root / for an unknown key. */
export function findFolderByKey(
  categories: PhotoCategory[] | undefined,
  key: string | null
): PhotoCategory | null {
  if (!key) return null;
  return (categories || []).find((c) => c.is_folder && folderKey(c) === key) || null;
}

/**
 * The photos in scope right now.
 *
 * Root: everything except photos living in a folder (uncategorised photos always
 * belong to root). Inside a folder: only that folder's photos.
 */
export function photosInScope(
  photos: Photo[] | undefined,
  categories: PhotoCategory[] | undefined,
  openFolderId: number | string | null
): Photo[] {
  const list = photos || [];
  if (openFolderId !== null && openFolderId !== undefined) {
    return list.filter((p) => p.category_id === openFolderId);
  }
  const folders = folderCategoryIds(categories);
  // Always a NEW array, even on the no-folders fast path: callers sort the
  // result in place, and handing back `data.photos` itself would sort the React
  // Query cache and reorder it for every other consumer.
  if (folders.size === 0) return [...list];
  return list.filter((p) => !p.category_id || !folders.has(p.category_id));
}

export interface FolderTile {
  category: PhotoCategory;
  count: number;
  coverPhoto: Photo | null;
}

/**
 * Folder tiles for the root view, in the order the backend resolved (#782).
 *
 * Only folders that actually hold photos get a tile — an empty folder would be a
 * dead end for a guest. The cover is the category hero (#163) when it is still
 * in the folder, else the folder's first photo.
 */
export function folderTiles(
  categories: PhotoCategory[] | undefined,
  photos: Photo[] | undefined
): FolderTile[] {
  const list = photos || [];
  return (categories || [])
    .filter((c) => c.is_folder)
    .map((category) => {
      const contents = list.filter((p) => p.category_id === category.id);
      const hero = category.hero_photo_id
        ? contents.find((p) => p.id === category.hero_photo_id) || null
        : null;
      return { category, count: contents.length, coverPhoto: hero || contents[0] || null };
    })
    .filter((tile) => tile.count > 0);
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

  return list
    .map((person) => ({ ...person, face_count: counts.get(person.id) || 0 }))
    .filter((person) => person.face_count > 0);
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
 */
export function writeFolderParam(slug: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (slug) {
    url.searchParams.set(FOLDER_QUERY_PARAM, slug);
  } else {
    url.searchParams.delete(FOLDER_QUERY_PARAM);
  }
  window.history.pushState({ [FOLDER_QUERY_PARAM]: slug }, '', url.toString());
}
