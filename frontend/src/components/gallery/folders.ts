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

/** The folder matching a `?folder=<slug>`, or null at root / for an unknown slug. */
export function findFolderBySlug(
  categories: PhotoCategory[] | undefined,
  slug: string | null
): PhotoCategory | null {
  if (!slug) return null;
  return (categories || []).find((c) => c.is_folder && c.slug === slug) || null;
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
  if (folders.size === 0) return list;
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
