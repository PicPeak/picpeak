/**
 * Link to a single photo (issue 1733) — the `?photo=` history protocol and
 * the rule that an id only ever resolves against the loaded list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  leavePhotoParam,
  pushPhotoParam,
  readPhotoParam,
  replacePhotoParam,
  resolvePhotoLink,
} from '../photoLink';
import { writeFolderParam, readFolderParam } from '../folders';
import type { Photo, PhotoCategory } from '../../../types';

const cat = (over: Partial<PhotoCategory> & { id: number; slug: string }): PhotoCategory => ({
  name: over.slug,
  is_global: false,
  ...over,
});

const photo = (id: number, category_id?: number | null): Photo =>
  ({ id, filename: `${id}.jpg`, category_id: category_id ?? null } as unknown as Photo);

const params = () => new URLSearchParams(window.location.search);

describe('readPhotoParam', () => {
  const original = window.location.href;
  afterEach(() => window.history.replaceState({}, '', original));

  it('reads a numeric id and nothing else', () => {
    window.history.replaceState({}, '', '/gallery/wed?photo=42');
    expect(readPhotoParam()).toBe(42);
    window.history.replaceState({}, '', '/gallery/wed?photo=abc');
    expect(readPhotoParam()).toBeNull();
    window.history.replaceState({}, '', '/gallery/wed');
    expect(readPhotoParam()).toBeNull();
  });
});

describe('resolvePhotoLink', () => {
  const categories = [cat({ id: 1, slug: 'ceremony', is_folder: true }), cat({ id: 2, slug: 'party' })];
  const photos = [photo(10), photo(11, 1), photo(12, 2)];

  it('resolves only against the loaded list — an unknown id is nothing', () => {
    expect(resolvePhotoLink(photos, categories, 999)).toBeNull();
    expect(resolvePhotoLink(undefined, categories, 10)).toBeNull();
    expect(resolvePhotoLink(photos, categories, null)).toBeNull();
  });

  it('names the folder a foldered photo needs open', () => {
    expect(resolvePhotoLink(photos, categories, 11)).toEqual({ photo: photos[1], folder: categories[0] });
  });

  it('keeps root photos and filter-category photos at root', () => {
    expect(resolvePhotoLink(photos, categories, 10)?.folder).toBeNull();
    expect(resolvePhotoLink(photos, categories, 12)?.folder).toBeNull();
  });
});

describe('history protocol', () => {
  const original = window.location.href;
  let back: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState({ idx: 3 }, '', '/gallery/wed?token=abc&folder=ceremony-1');
    back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  });
  afterEach(() => {
    back.mockRestore();
    window.history.replaceState({}, '', original);
  });

  it('opening from a tile pushes one entry and keeps the other params', () => {
    const push = vi.spyOn(window.history, 'pushState');
    pushPhotoParam(42);
    expect(push).toHaveBeenCalledTimes(1);
    expect(params().get('photo')).toBe('42');
    expect(params().get('token')).toBe('abc');
    expect(params().get('folder')).toBe('ceremony-1');
    // The router's own state survives alongside ours.
    expect(window.history.state).toMatchObject({ idx: 3, photo: 42, photoPushed: true });
    push.mockRestore();
  });

  it('stepping replaces instead of pushing, and keeps the pushed flag', () => {
    pushPhotoParam(42);
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    replacePhotoParam(43);
    replacePhotoParam(44);
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(2);
    expect(params().get('photo')).toBe('44');
    expect(window.history.state.photoPushed).toBe(true);
    push.mockRestore();
    replace.mockRestore();
  });

  it('a step onto the photo already in the URL rewrites nothing', () => {
    pushPhotoParam(42);
    const replace = vi.spyOn(window.history, 'replaceState');
    replacePhotoParam(42);
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it('closing after a push goes back, however many steps were taken', () => {
    pushPhotoParam(42);
    replacePhotoParam(43);
    leavePhotoParam();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('closing a deep-linked lightbox drops the param and never goes back', () => {
    // Arrived on the link: no entry of ours underneath.
    window.history.replaceState({ idx: 0 }, '', '/gallery/wed?token=abc&photo=42');
    replacePhotoParam(42); // the lightbox reporting its opening photo
    leavePhotoParam();
    expect(back).not.toHaveBeenCalled();
    expect(params().get('photo')).toBeNull();
    expect(params().get('token')).toBe('abc');
    expect(window.history.state).toEqual({ idx: 0 });
  });

  it('closing with no photo in the URL is a no-op', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    leavePhotoParam();
    expect(back).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it('a deep link into a folder switches the folder in place, keeping the photo', () => {
    window.history.replaceState({}, '', '/gallery/wed?token=abc&photo=11');
    const push = vi.spyOn(window.history, 'pushState');
    writeFolderParam('ceremony-1', { replace: true });
    expect(push).not.toHaveBeenCalled();
    expect(readFolderParam()).toBe('ceremony-1');
    expect(readPhotoParam()).toBe(11);
    expect(params().get('token')).toBe('abc');
    push.mockRestore();
  });
});
