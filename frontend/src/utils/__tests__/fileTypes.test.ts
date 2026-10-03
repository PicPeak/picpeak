import { describe, it, expect } from 'vitest';
import { extensionsToMimeTypes, extensionsToAcceptString, extensionsToLabel, buildUploadAcceptString, normalizeFileMimeType, isAllowedUploadFile } from '../fileTypes';

describe('fileTypes', () => {
  describe('extensionsToMimeTypes', () => {
    it('maps known extensions to MIME types', () => {
      expect(extensionsToMimeTypes('jpg,png,mov')).toEqual(['image/jpeg', 'image/png', 'video/quicktime']);
    });
    it('supports HEIC/HEIF (#821)', () => {
      expect(extensionsToMimeTypes('heic,heif')).toEqual(['image/heic', 'image/heif']);
    });
    it('supports DNG (#821)', () => {
      expect(extensionsToMimeTypes('dng')).toEqual(['image/x-adobe-dng']);
    });
    it('drops unknown extensions and falls back to default when nothing maps', () => {
      expect(extensionsToMimeTypes('abc,xyz')).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    });
  });

  describe('extensionsToLabel', () => {
    it('renders a de-duplicated, upper-cased list of the configured formats', () => {
      expect(extensionsToLabel('jpg,jpeg,png,webp,mov')).toBe('JPG, JPEG, PNG, WEBP, MOV');
    });
    it('only lists supported extensions (drops unknowns like xyz)', () => {
      expect(extensionsToLabel('jpg,png,xyz')).toBe('JPG, PNG');
    });
    it('falls back to the default set when empty', () => {
      expect(extensionsToLabel('')).toBe('JPG, JPEG, PNG, WEBP');
      expect(extensionsToLabel(null)).toBe('JPG, JPEG, PNG, WEBP');
    });
  });

  describe('extensionsToAcceptString', () => {
    it('joins MIME types for the input accept attribute', () => {
      expect(extensionsToAcceptString('jpg,heic')).toBe('image/jpeg,image/heic');
    });

    it('also lists RAW extensions in dotted form', () => {
      // A MIME-only accept list greys .arw out in the picker: the OS has no
      // MIME for it, so there is nothing for the list to match.
      expect(extensionsToAcceptString('jpg,arw')).toBe('image/jpeg,image/x-sony-arw,.arw');
    });

    it('leaves an ordinary accept string untouched', () => {
      // Non-MIME tokens reroute the Android picker, so nothing gets one unless
      // the format actually needs it.
      expect(extensionsToAcceptString('jpg,jpeg,png,webp'))
        .toBe('image/jpeg,image/png,image/webp');
    });
  });

  describe('untyped uploads (camera RAW)', () => {
    const file = (name: string, type = '') => ({ name, type });
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/x-sony-arw'];

    it('names a RAW type from the extension when the browser gives none', () => {
      expect(normalizeFileMimeType('DSC01234.ARW', '')).toBe('image/x-sony-arw');
      expect(normalizeFileMimeType('DSC01234.arw', 'application/octet-stream'))
        .toBe('image/x-sony-arw');
      // A TIFF container is what a RAW is, so image/tiff is honest and still
      // tells the vendor formats apart not at all.
      expect(normalizeFileMimeType('DSC01234.arw', 'image/tiff')).toBe('image/x-sony-arw');
    });

    it('leaves anything else exactly as the browser typed it', () => {
      expect(normalizeFileMimeType('holiday.jpg', '')).toBe('');
      expect(normalizeFileMimeType('payload.exe', 'application/octet-stream'))
        .toBe('application/octet-stream');
    });

    it('accepts a RAW file only where the settings allow it', () => {
      expect(isAllowedUploadFile(file('DSC01234.ARW'), allowed)).toBe(true);
      expect(isAllowedUploadFile(file('DSC01234.ARW'), ['image/jpeg'])).toBe(false);
    });

    it('does not loosen anything else', () => {
      expect(isAllowedUploadFile(file('payload.exe'), allowed)).toBe(false);
      expect(isAllowedUploadFile(file('holiday.jpg'), allowed)).toBe(false);
      expect(isAllowedUploadFile(file('holiday.jpg', 'image/jpeg'), allowed)).toBe(true);
    });
  });

  describe('buildUploadAcceptString (#1117)', () => {
    const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36';
    const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile Safari/604.1';
    const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';
    const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 16; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0';

    it('appends the camera token on Android so the chooser offers the camera', () => {
      expect(buildUploadAcceptString('jpg,png', ANDROID)).toBe('image/jpeg,image/png,android/allowCamera');
    });

    it('adds nothing a guest could actually select', () => {
      // The token exists to flip Chrome out of the photo picker, not to widen
      // the allowlist. An earlier revision used .pdf, which does flip it but
      // also offers PDFs — pick one and you get "Invalid file type".
      const accept = buildUploadAcceptString('jpg,png', ANDROID);
      expect(accept).not.toMatch(/\.pdf|application\/pdf/);
      expect(accept.split(',').filter((t) => t.startsWith('image/') || t.startsWith('video/')))
        .toEqual(['image/jpeg', 'image/png']);
    });


    it('leaves Firefox for Android alone — its chooser already offers the camera', () => {
      // The UA says Android, but the behaviour this works around is Chromium's.
      expect(buildUploadAcceptString('jpg,png', FIREFOX_ANDROID)).toBe('image/jpeg,image/png');
    });
    it('leaves iOS and desktop untouched — their pickers already work', () => {
      expect(buildUploadAcceptString('jpg,png', IOS)).toBe('image/jpeg,image/png');
      expect(buildUploadAcceptString('jpg,png', DESKTOP)).toBe('image/jpeg,image/png');
    });

    it('keeps offering video when the admin configured it', () => {
      // The workaround must not narrow the accept list to images: an install
      // with video enabled still has to offer mp4/mov in the chooser.
      expect(buildUploadAcceptString('jpg,mp4,mov', ANDROID)).toBe('image/jpeg,video/mp4,video/quicktime,android/allowCamera');
    });

    it('falls back to the configured default set, not a wider image/*', () => {
      expect(buildUploadAcceptString('', DESKTOP)).toBe('image/jpeg,image/png,image/webp');
      expect(buildUploadAcceptString('', ANDROID)).toBe('image/jpeg,image/png,image/webp,android/allowCamera');
    });
  });
});
