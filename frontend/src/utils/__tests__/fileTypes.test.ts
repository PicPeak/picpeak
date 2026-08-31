import { describe, it, expect } from 'vitest';
import { extensionsToMimeTypes, extensionsToAcceptString, extensionsToLabel, buildUploadAcceptString } from '../fileTypes';

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
  });

  describe('buildUploadAcceptString (#1117)', () => {
    const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36';
    const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile Safari/604.1';
    const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';

    it('appends .pdf on Android so the chooser offers the camera', () => {
      expect(buildUploadAcceptString('jpg,png', ANDROID)).toBe('image/jpeg,image/png,.pdf');
    });

    it('leaves iOS and desktop untouched — their pickers already work', () => {
      expect(buildUploadAcceptString('jpg,png', IOS)).toBe('image/jpeg,image/png');
      expect(buildUploadAcceptString('jpg,png', DESKTOP)).toBe('image/jpeg,image/png');
    });

    it('keeps offering video when the admin configured it', () => {
      // The workaround must not narrow the accept list to images: an install
      // with video enabled still has to offer mp4/mov in the chooser.
      expect(buildUploadAcceptString('jpg,mp4,mov', ANDROID)).toBe('image/jpeg,video/mp4,video/quicktime,.pdf');
    });

    it('falls back to the configured default set, not a wider image/*', () => {
      expect(buildUploadAcceptString('', DESKTOP)).toBe('image/jpeg,image/png,image/webp');
      expect(buildUploadAcceptString('', ANDROID)).toBe('image/jpeg,image/png,image/webp,.pdf');
    });
  });
});
