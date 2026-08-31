import { describe, it, expect } from 'vitest';
import { buildUploadAcceptString } from '../fileTypes';

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
