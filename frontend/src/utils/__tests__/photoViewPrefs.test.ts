/**
 * Coverage for the admin Photos-tab layout toggle persistence.
 *
 * The event detail Photos tab can render as a Grid or a List; the
 * choice is stored per browser/admin via localStorage so it survives
 * reloads. These tests pin the default ('grid'), the round-trip, and
 * the defensive fallback on malformed / blocked storage so a refactor
 * can't silently break the persisted preference.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPhotoViewMode, setPhotoViewMode } from '../photoViewPrefs';

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
