/**
 * Gallery folders (#1160) — the containment rule.
 *
 * The whole point of the feature: a foldered photo is ABSENT from the root grid
 * and only appears inside its folder. A filter category keeps today's behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  filterCategories,
  peopleInScope,
  SELECTED_DOWNLOAD_LIMIT,
  findFolderByKey,
  folderKey,
  folderCategoryIds,
  folderTiles,
  photosInScope,
  readFolderParam,
  writeFolderParam,
} from '../folders';
import type { Photo, PhotoCategory } from '../../../types';

const cat = (over: Partial<PhotoCategory> & { id: number; slug: string }): PhotoCategory => ({
  name: over.slug,
  is_global: false,
  ...over,
});

const photo = (id: number, category_id?: number | null): Photo =>
  ({ id, filename: `${id}.jpg`, category_id: category_id ?? null } as unknown as Photo);

const CATEGORIES: PhotoCategory[] = [
  cat({ id: 1, slug: 'ceremony' }),
  cat({ id: 2, slug: 'selects', is_folder: true }),
  cat({ id: 3, slug: 'bw', is_folder: true }),
];

// 2 finals (one categorised, one loose), 3 in a folder, 1 in another folder.
const PHOTOS: Photo[] = [
  photo(10, 1),
  photo(11, null),
  photo(20, 2),
  photo(21, 2),
  photo(22, 2),
  photo(30, 3),
];

describe('photosInScope', () => {
  it('drops every foldered photo from the root grid', () => {
    const ids = photosInScope(PHOTOS, CATEGORIES, null).map((p) => p.id);
    expect(ids).toEqual([10, 11]);
  });

  it('keeps uncategorised photos at root', () => {
    expect(photosInScope(PHOTOS, CATEGORIES, null).map((p) => p.id)).toContain(11);
  });

  it('shows only that folder’s photos inside a folder', () => {
    expect(photosInScope(PHOTOS, CATEGORIES, 2).map((p) => p.id)).toEqual([20, 21, 22]);
    expect(photosInScope(PHOTOS, CATEGORIES, 3).map((p) => p.id)).toEqual([30]);
  });

  it('leaves a gallery without folders completely unchanged', () => {
    const filtersOnly = [cat({ id: 1, slug: 'ceremony' })];
    expect(photosInScope(PHOTOS, filtersOnly, null)).toHaveLength(PHOTOS.length);
  });

  // Callers sort the result in place. Returning `photos` itself on the
  // no-folders fast path sorted the React Query cache for every other consumer.
  it('never hands back the caller’s own array', () => {
    const filtersOnly = [cat({ id: 1, slug: 'ceremony' })];
    const out = photosInScope(PHOTOS, filtersOnly, null);
    expect(out).not.toBe(PHOTOS);
    out.sort((a, b) => b.id - a.id);
    expect(PHOTOS.map((p) => p.id)).toEqual([10, 11, 20, 21, 22, 30]);
  });

  it('treats a category as a filter until is_folder is set', () => {
    const asFilter = [cat({ id: 2, slug: 'selects' })];
    expect(photosInScope(PHOTOS, asFilter, null)).toHaveLength(PHOTOS.length);
  });
});

describe('folderTiles', () => {
  it('builds one tile per non-empty folder with its count', () => {
    const tiles = folderTiles(CATEGORIES, PHOTOS);
    expect(tiles.map((t) => [t.category.slug, t.count])).toEqual([
      ['selects', 3],
      ['bw', 1],
    ]);
  });

  it('hides empty folders — a guest must not hit a dead end', () => {
    const tiles = folderTiles([...CATEGORIES, cat({ id: 4, slug: 'empty', is_folder: true })], PHOTOS);
    expect(tiles.map((t) => t.category.slug)).not.toContain('empty');
  });

  it('prefers the category hero as the cover, else the first photo', () => {
    const withHero = [cat({ id: 2, slug: 'selects', is_folder: true, hero_photo_id: 22 })];
    expect(folderTiles(withHero, PHOTOS)[0].coverPhoto?.id).toBe(22);
    expect(folderTiles([CATEGORIES[1]], PHOTOS)[0].coverPhoto?.id).toBe(20);
  });

  it('falls back to the first photo when the hero left the folder', () => {
    const staleHero = [cat({ id: 2, slug: 'selects', is_folder: true, hero_photo_id: 999 })];
    expect(folderTiles(staleHero, PHOTOS)[0].coverPhoto?.id).toBe(20);
  });
});

describe('findFolderByKey / folderKey', () => {
  it('resolves an open folder', () => {
    expect(findFolderByKey(CATEGORIES, 'selects-2')?.id).toBe(2);
  });

  it('falls back to root for an unknown key rather than emptying the gallery', () => {
    expect(findFolderByKey(CATEGORIES, 'nope')).toBeNull();
  });

  it('refuses to open a filter category as a folder', () => {
    expect(findFolderByKey(CATEGORIES, 'ceremony')).toBeNull();
  });

  // Regression: adminCategories slugs with `[^\w\s-]` stripping, and `\w` is
  // ASCII-only — "Избранное" slugs to "". Keying on the slug made such a
  // folder's photos unreachable: gone from the root grid, and the empty param
  // neither wrote nor resolved.
  it('keys a folder by id when its name slugs to nothing', () => {
    const cyrillic = cat({ id: 7, slug: '', name: 'Избранное', is_folder: true });
    expect(folderKey(cyrillic)).toBe('7');
    expect(findFolderByKey([cyrillic], '7')?.id).toBe(7);
  });

  it('keeps the slug in the key so links stay readable', () => {
    expect(folderKey(CATEGORIES[1])).toBe('selects-2');
  });

  // Regression: UNIQUE is (slug, event_id), so a global folder and an
  // event-specific folder can share a slug. Keying on the slug alone made the
  // second one unopenable — every lookup matched the first.
  it('distinguishes two folders that share a slug across scopes', () => {
    const globalSelects = cat({ id: 20, slug: 'selects', is_global: true, is_folder: true });
    const eventSelects = cat({ id: 21, slug: 'selects', is_folder: true });
    const both = [globalSelects, eventSelects];
    expect(folderKey(globalSelects)).not.toBe(folderKey(eventSelects));
    expect(findFolderByKey(both, folderKey(eventSelects))?.id).toBe(21);
    expect(findFolderByKey(both, folderKey(globalSelects))?.id).toBe(20);
  });
});

describe('filterCategories / folderCategoryIds', () => {
  it('offers only filter categories to the filter UI', () => {
    expect(filterCategories(CATEGORIES).map((c) => c.slug)).toEqual(['ceremony']);
  });

  it('collects folder ids', () => {
    expect([...folderCategoryIds(CATEGORIES)]).toEqual([2, 3]);
  });
});

describe('peopleInScope', () => {
  // photo 10 -> Anna; 11 -> Anna+Ben; folder photos 20,21 -> Chris; 30 -> Ben
  const withPeople: Photo[] = [
    { ...photo(10, 1), person_ids: [1] },
    { ...photo(11, null), person_ids: [1, 2] },
    { ...photo(20, 2), person_ids: [3] },
    { ...photo(21, 2), person_ids: [3] },
    { ...photo(22, 2), person_ids: [] },
    { ...photo(30, 3), person_ids: [2] },
  ] as unknown as Photo[];

  const PEOPLE = [
    { id: 1, face_count: 99 },
    { id: 2, face_count: 99 },
    { id: 3, face_count: 99 },
  ];

  it('recounts against the photos actually on screen', () => {
    const atRoot = peopleInScope(PEOPLE, photosInScope(withPeople, CATEGORIES, null));
    expect(atRoot).toEqual([
      { id: 1, face_count: 2 },
      { id: 2, face_count: 1 },
    ]);
  });

  it('drops a person whose photos all live in a folder — no dead chip at root', () => {
    const atRoot = peopleInScope(PEOPLE, photosInScope(withPeople, CATEGORIES, null));
    expect(atRoot.map((p) => p.id)).not.toContain(3);
  });

  it('counts only the folder’s photos while inside it', () => {
    const inFolder = peopleInScope(PEOPLE, photosInScope(withPeople, CATEGORIES, 2));
    expect(inFolder).toEqual([{ id: 3, face_count: 2 }]);
  });

  it('is a no-op for a gallery without folders', () => {
    const noFolders = [cat({ id: 1, slug: 'ceremony' })];
    const scoped = peopleInScope(PEOPLE, photosInScope(withPeople, noFolders, null));
    expect(scoped.map((p) => [p.id, p.face_count])).toEqual([[1, 2], [2, 2], [3, 2]]);
  });
});

describe('SELECTED_DOWNLOAD_LIMIT', () => {
  // Mirrors the server-side `.slice(0, 500)` in gallery.js's /download-selected
  // and /download-jobs. If the backend cap moves and this doesn't, the folder
  // button silently promises more than the archive will contain.
  it('matches the cap the backend enforces', () => {
    expect(SELECTED_DOWNLOAD_LIMIT).toBe(500);
  });
});

describe('URL round-trip', () => {
  const original = window.location.href;

  beforeEach(() => window.history.replaceState({}, '', '/gallery/wed?token=abc&admin_preview=1'));
  afterEach(() => window.history.replaceState({}, '', original));

  it('reflects the open folder without dropping token or admin_preview', () => {
    writeFolderParam('selects');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('folder')).toBe('selects');
    expect(params.get('token')).toBe('abc');
    expect(params.get('admin_preview')).toBe('1');
    expect(readFolderParam()).toBe('selects');
  });

  it('clears the param on the way back to root', () => {
    writeFolderParam('selects');
    writeFolderParam(null);
    expect(readFolderParam()).toBeNull();
    expect(new URLSearchParams(window.location.search).get('token')).toBe('abc');
  });
});
