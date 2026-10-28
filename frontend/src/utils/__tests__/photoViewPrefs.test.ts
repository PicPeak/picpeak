/**
 * Coverage for the admin Photos-tab layout toggle persistence.
 *
 * The event detail Photos tab can render as a Grid or a List; the
 * choice is stored per browser/admin via localStorage so it survives
 * reloads. These tests pin the default ('grid'), the round-trip, and
 * the defensive fallback on malformed / blocked storage so a refactor
 * can't silently break the persisted preference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHiddenPhotoColumns, getPhotoViewMode, setHiddenPhotoColumns, setPhotoViewMode } from '../photoViewPrefs';

describe('photoViewPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to grid when nothing is stored', () => {
    expect(getPhotoViewMode()).toBe('grid');
  });

  it('round-trips a persisted view mode', () => {
    setPhotoViewMode('list');
    expect(getPhotoViewMode()).toBe('list');
    setPhotoViewMode('grid');
    expect(getPhotoViewMode()).toBe('grid');
  });

  it('falls back to grid for an unrecognised stored value', () => {
    localStorage.setItem('picpeak.adminPhotos.view', 'mosaic');
    expect(getPhotoViewMode()).toBe('grid');
  });

  it('ignores attempts to persist an invalid view mode', () => {
    setPhotoViewMode('list');
    // @ts-expect-error — exercising the runtime guard against bad input
    setPhotoViewMode('carousel');
    expect(getPhotoViewMode()).toBe('list');
  });
});

describe('hidden photo list columns (issue 1739)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('hides nothing by default', () => {
    expect(getHiddenPhotoColumns()).toEqual([]);
  });

  it('round-trips, in table order, and drops unknown names', () => {
    setHiddenPhotoColumns(['size', 'captured']);
    expect(getHiddenPhotoColumns()).toEqual(['captured', 'size']);
    localStorage.setItem('picpeak.adminPhotos.prefs', JSON.stringify({ hiddenColumns: ['size', 'photo', 'bogus'] }));
    expect(getHiddenPhotoColumns()).toEqual(['size']);
  });

  it('keeps other keys in the prefs object', () => {
    localStorage.setItem('picpeak.adminPhotos.prefs', JSON.stringify({ other: 1 }));
    setHiddenPhotoColumns(['credit']);
    expect(JSON.parse(localStorage.getItem('picpeak.adminPhotos.prefs')!)).toEqual({ other: 1, hiddenColumns: ['credit'] });
  });

  it('falls back to none on a malformed value', () => {
    localStorage.setItem('picpeak.adminPhotos.prefs', '{not json');
    expect(getHiddenPhotoColumns()).toEqual([]);
    localStorage.setItem('picpeak.adminPhotos.prefs', JSON.stringify({ hiddenColumns: 'size' }));
    expect(getHiddenPhotoColumns()).toEqual([]);
    // A later save repairs it.
    setHiddenPhotoColumns(['size']);
    expect(getHiddenPhotoColumns()).toEqual(['size']);
  });

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(getHiddenPhotoColumns()).toEqual([]);
    expect(() => setHiddenPhotoColumns(['size'])).not.toThrow();
  });
});
