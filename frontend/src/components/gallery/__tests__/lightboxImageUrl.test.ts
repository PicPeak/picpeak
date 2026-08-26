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
 * installs; the tests below pin that, and pin the two cases that must still
 * reach `url`.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { lightboxImageUrl } from '../imageTiers';

const realWidth = window.innerWidth;
const realDpr = window.devicePixelRatio;

function setViewport(width: number, dpr: number, height = 844) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
}

// Desktop, so the top tier is chosen and no ?w= is appended — keeps these
// assertions about URL SELECTION rather than tier maths (pinned separately in
// imageTiers.test.ts).
afterEach(() => setViewport(realWidth, realDpr));

const BIG = { width: 4160, height: 6240 };

describe('lightboxImageUrl (#1166)', () => {
  it('uses the preview tier when the admin opted in', () => {
    setViewport(1440, 2, 900);
    expect(lightboxImageUrl({
      url: '/api/gallery/g/photo/47',
      preview_url: '/api/gallery/g/preview/47',
      slideshow_url: '/api/gallery/g/preview/47',
      ...BIG,
    })).toBe('/api/gallery/g/preview/47');
  });

  it('uses the preview tier when they did NOT — the reported install', () => {
    // The regression, exactly as filed: preview_url null, slideshow_url set.
    setViewport(1440, 2, 900);
    expect(lightboxImageUrl({
      url: '/api/gallery/g/photo/47',
      preview_url: null,
      slideshow_url: '/api/gallery/g/preview/47',
      ...BIG,
    })).toBe('/api/gallery/g/preview/47');
  });

  it('never serves the original while a derivative exists', () => {
    setViewport(1440, 2, 900);
    for (const preview_url of [null, undefined, '', '/api/gallery/g/preview/47']) {
      expect(lightboxImageUrl({
        url: '/api/gallery/g/photo/47',
        preview_url,
        slideshow_url: '/api/gallery/g/preview/47',
        ...BIG,
      })).not.toContain('/photo/');
    }
  });

  it('falls back to the original when neither derivative exists', () => {
    // Videos: the server emits null for both, and the player needs the real
    // source.
    expect(lightboxImageUrl({
      url: '/api/gallery/g/photo/47',
      preview_url: null,
      slideshow_url: null,
    })).toBe('/api/gallery/g/photo/47');
  });

  it('carries the watermark query through', () => {
    // preview_url and slideshow_url are built from the same string server-side
    // (gallery.js), so the wm parameter is on whichever one is used — losing it
    // would serve an unwatermarked frame to a gallery that asked for one.
    setViewport(1440, 2, 900);
    expect(lightboxImageUrl({
      url: '/api/gallery/g/photo/47?wm=3',
      preview_url: null,
      slideshow_url: '/api/gallery/g/preview/47?wm=3',
      ...BIG,
    })).toBe('/api/gallery/g/preview/47?wm=3');
  });

  it.each(['image/gif', 'image/apng', 'image/png', 'image/webp', 'image/jpeg'])(
    'uses the preview tier for %s — the backend preserves alpha and frames now',
    (mime_type) => {
      // The bypass list this replaces existed because generatePreviewImage
      // always encoded JPEG. Previews of alpha or multi-page sources are WebP
      // now, so there is nothing left for the frontend to guess at.
      setViewport(1440, 2, 900);
      expect(lightboxImageUrl({
        url: '/api/gallery/g/photo/47',
        preview_url: null,
        slideshow_url: '/api/gallery/g/preview/47',
        mime_type,
        ...BIG,
      } as Parameters<typeof lightboxImageUrl>[0])).toBe('/api/gallery/g/preview/47');
    },
  );

  it('still sizes the fallback tier for the device', () => {
    // The #1095 behaviour has to survive the new fallback: a phone must not
    // pull the 1920 rendition just because the URL came from slideshow_url.
    setViewport(390, 3);
    // A tall portrait is bound by height, so a DPR-3 phone genuinely needs the
    // top tier — which is served without ?w=, keeping those URLs byte-identical
    // to the ones already in browser and CDN caches.
    expect(lightboxImageUrl({
      url: '/api/gallery/g/photo/47',
      preview_url: null,
      slideshow_url: '/api/gallery/g/preview/47',
      ...BIG,
    })).toBe('/api/gallery/g/preview/47');

    // Landscape on the same phone needs less, and says so.
    expect(lightboxImageUrl({
      url: '/api/gallery/g/photo/47',
      preview_url: null,
      slideshow_url: '/api/gallery/g/preview/47',
      width: 3000,
      height: 2000,
    })).toBe('/api/gallery/g/preview/47?w=1280');
  });
});
