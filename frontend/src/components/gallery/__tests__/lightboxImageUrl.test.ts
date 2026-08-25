/**
 * The lightbox must not display a photo by downloading the original (#1166).
 *
 * `preview_url` is only emitted when the admin has flipped
 * lightbox_preview_enabled, which is off by default — so a stock install fell
 * through to `url`. A reporter measured 16.5 MB for a photo whose preview is
 * 345 KB, and the lightbox renders its neighbours too, so one open pulled
 * three originals.
 *
 * `slideshow_url` is the same /preview/:id URL and has been emitted
 * unconditionally for images since #1015. Preferring it is what fixes existing
 * installs.
 *
 * No viewport-tier cases here: the responsive `?w=` machinery (#1095) is
 * main-only, so this branch uses the URLs exactly as the server emits them.
 */
import { describe, it, expect } from 'vitest';

import { lightboxImageUrl } from '../imageTiers';

const PHOTO = {
  url: '/api/gallery/g/photo/47',
  preview_url: null as string | null,
  slideshow_url: '/api/gallery/g/preview/47' as string | null,
};

describe('lightboxImageUrl (#1166)', () => {
  it('uses the preview tier when the admin opted in', () => {
    expect(lightboxImageUrl({ ...PHOTO, preview_url: '/api/gallery/g/preview/47' }))
      .toBe('/api/gallery/g/preview/47');
  });

  it('uses the preview tier when they did NOT — the reported install', () => {
    // The regression, exactly as filed: preview_url null, slideshow_url set.
    expect(lightboxImageUrl(PHOTO)).toBe('/api/gallery/g/preview/47');
  });

  it('never serves the original while a derivative exists', () => {
    for (const preview_url of [null, undefined, '', '/api/gallery/g/preview/47']) {
      expect(lightboxImageUrl({ ...PHOTO, preview_url })).not.toContain('/photo/');
    }
  });

  it('falls back to the original when neither derivative exists', () => {
    // Videos: the server emits null for both, and the player needs the real
    // source.
    expect(lightboxImageUrl({ ...PHOTO, preview_url: null, slideshow_url: null }))
      .toBe('/api/gallery/g/photo/47');
  });

  it('carries the watermark query through', () => {
    // preview_url and slideshow_url are built from the same string server-side,
    // so the wm parameter is on whichever one is used — losing it would serve
    // an unwatermarked frame to a gallery that asked for one.
    expect(lightboxImageUrl({
      url: '/api/gallery/g/photo/47?wm=3',
      preview_url: null,
      slideshow_url: '/api/gallery/g/preview/47?wm=3',
    })).toBe('/api/gallery/g/preview/47?wm=3');
  });

  it.each(['image/gif', 'image/apng', 'image/png'])(
    'keeps the original for %s, which the preview tier would flatten',
    (mime_type) => {
      // generatePreviewImage encodes JPEG: no second frame, no alpha channel.
      expect(lightboxImageUrl({ ...PHOTO, mime_type })).toBe('/api/gallery/g/photo/47');
    },
  );

  it('still uses the preview tier for ordinary still formats', () => {
    for (const mime_type of ['image/jpeg', 'image/webp', undefined]) {
      expect(lightboxImageUrl({ ...PHOTO, mime_type })).toBe('/api/gallery/g/preview/47');
    }
  });
});
