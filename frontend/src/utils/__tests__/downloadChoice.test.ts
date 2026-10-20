/**
 * Download menu (issue 1733, E2): a camera RAW, HEIC/HEIF or AVIF photo skips
 * the size menu because the download route hands it out at its uploaded size
 * whatever is picked. The frontend's RAW list must name every format the
 * backend's does, or the menu offers a size the server ignores.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { downloadsAtUploadedSize } from '../downloadChoice';

const backendRawExtensions = (): string[] => {
  const source = readFileSync(resolve(__dirname, '../../../../backend/src/utils/rawFormats.js'), 'utf8');
  const list = source.match(/const RAW_EXTENSIONS = new Set\(\[([\s\S]*?)\]\)/);
  if (!list) throw new Error('RAW_EXTENSIONS not found in backend/src/utils/rawFormats.js');
  return Array.from(list[1].matchAll(/'([a-z0-9]+)'/g), (m) => m[1]);
};

describe('downloadsAtUploadedSize', () => {
  it('knows every RAW format the backend ships as stored', () => {
    const exts = backendRawExtensions();
    expect(exts.length).toBeGreaterThan(10);
    for (const ext of exts) {
      expect(downloadsAtUploadedSize({ original_filename: `IMG_1.${ext.toUpperCase()}` })).toBe(true);
    }
  });

  it('reads the original filename first, as the route does, then the stored one', () => {
    expect(downloadsAtUploadedSize({ original_filename: 'a.nef', filename: 'a.jpg' })).toBe(true);
    expect(downloadsAtUploadedSize({ original_filename: null, filename: 'a.arw' })).toBe(true);
    expect(downloadsAtUploadedSize({ original_filename: 'a.jpg', filename: 'a.jpg' })).toBe(false);
    expect(downloadsAtUploadedSize({ filename: 'noext' })).toBe(false);
  });

  it('counts HEIC, HEIF and AVIF, which resizeToBox hands back unresized', () => {
    for (const name of ['a.HEIC', 'a.heif', 'a.avif']) {
      expect(downloadsAtUploadedSize({ original_filename: name })).toBe(true);
    }
    for (const name of ['a.png', 'a.webp', 'a.gif', 'a.jpeg']) {
      expect(downloadsAtUploadedSize({ original_filename: name })).toBe(false);
    }
  });
});
