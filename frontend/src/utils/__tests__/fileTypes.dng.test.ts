/**
 * DNG in the upload choosers (issue 821).
 *
 * `accept` listed only image/x-adobe-dng for a DNG. File choosers match accept
 * MIME types against the OS type table, and macOS, iOS and Windows do not map
 * .dng to that type, so DNG files were hidden. Picking one anyway ("All files")
 * then failed the client-side check whenever the browser reported the file as
 * anything other than exactly image/x-adobe-dng.
 */
import { describe, it, expect } from 'vitest';
import { extensionsToAcceptString, buildUploadAcceptString, normalizeFileMimeType } from '../fileTypes';

describe('accept string for DNG', () => {
  it('names the .dng extension alongside its MIME type', () => {
    expect(extensionsToAcceptString('jpg,dng')).toBe('image/jpeg,image/x-adobe-dng,.dng');
  });

  it('adds nothing when DNG is not configured', () => {
    expect(extensionsToAcceptString('jpg,png')).toBe('image/jpeg,image/png');
    expect(extensionsToAcceptString('')).toBe('image/jpeg,image/png,image/webp');
  });

  it('keeps the Android camera token last', () => {
    const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36';
    expect(buildUploadAcceptString('jpg,dng', ANDROID)).toBe('image/jpeg,image/x-adobe-dng,.dng,android/allowCamera');
  });
});

describe('normalizeFileMimeType', () => {
  it.each(['', 'application/octet-stream', 'image/dng', 'image/x-dng', 'image/tiff'])(
    'treats a .dng reported as %j as image/x-adobe-dng',
    (reported) => {
      expect(normalizeFileMimeType('IMG_0001.DNG', reported)).toBe('image/x-adobe-dng');
    },
  );

  it('leaves other files and other claims alone', () => {
    expect(normalizeFileMimeType('photo.jpg', '')).toBe('');
    expect(normalizeFileMimeType('shot.dng', 'image/jpeg')).toBe('image/jpeg');
    expect(normalizeFileMimeType('photo.jpg', 'image/jpeg')).toBe('image/jpeg');
  });
});
