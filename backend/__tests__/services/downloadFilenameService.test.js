/**
 * Pure-logic tests for the #493 download-filename helpers that don't depend
 * on the DB (those are covered by the route integration suite).
 */

const {
  pickRawDownloadName,
  getZipEntryNames,
} = require('../../src/services/downloadFilenameService');

describe('pickRawDownloadName', () => {
  it('returns the storage filename when the toggle is off', () => {
    expect(
      pickRawDownloadName({ id: 1, filename: 'slug_001.jpg', original_filename: 'DSC_1.jpg' }, false)
    ).toBe('slug_001.jpg');
  });

  it('returns original_filename when the toggle is on', () => {
    expect(
      pickRawDownloadName({ id: 1, filename: 'slug_001.jpg', original_filename: 'DSC_1.jpg' }, true)
    ).toBe('DSC_1.jpg');
  });

  it('falls back to storage filename when original_filename is missing', () => {
    expect(
      pickRawDownloadName({ id: 1, filename: 'slug_001.jpg', original_filename: null }, true)
    ).toBe('slug_001.jpg');
  });

  it('produces a stable last-resort name when both are missing', () => {
    expect(pickRawDownloadName({ id: 42 }, true)).toBe('photo-42.jpg');
  });
});

describe('getZipEntryNames', () => {
  it('uses original filenames with deterministic suffixes on collision', () => {
    const photos = [
      { id: 1, filename: 'slug_001.jpg', original_filename: 'DSC_1234.jpg' },
      { id: 2, filename: 'slug_002.jpg', original_filename: 'DSC_1234.jpg' },
      { id: 3, filename: 'slug_003.jpg', original_filename: 'DSC_1235.jpg' },
    ];
    expect(getZipEntryNames(photos, true)).toEqual([
      'DSC_1234.jpg',
      'DSC_1234_1.jpg',
      'DSC_1235.jpg',
    ]);
  });

  it('falls back to storage filename per-photo when original is missing', () => {
    const photos = [
      { id: 1, filename: 'slug_001.jpg', original_filename: 'DSC_1.jpg' },
      { id: 2, filename: 'slug_002.jpg', original_filename: null },
    ];
    expect(getZipEntryNames(photos, true)).toEqual([
      'DSC_1.jpg',
      'slug_002.jpg',
    ]);
  });

  it('returns storage filenames when the toggle is off, dedup still applies', () => {
    const photos = [
      { id: 1, filename: 'a.jpg', original_filename: 'DSC_1.jpg' },
      { id: 2, filename: 'a.jpg', original_filename: 'DSC_2.jpg' },
    ];
    expect(getZipEntryNames(photos, false)).toEqual(['a.jpg', 'a_1.jpg']);
  });

  it('sanitizes path-traversal attempts that sneak into original_filename', () => {
    const photos = [
      { id: 1, filename: 'slug_001.jpg', original_filename: '../etc/passwd' },
    ];
    const [name] = getZipEntryNames(photos, true);
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });
});
