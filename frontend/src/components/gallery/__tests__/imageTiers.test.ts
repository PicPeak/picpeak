/**
 * Preview tier selection (#1095).
 *
 * The point of the feature is that a phone stops pulling a 1920px rendition it
 * cannot display. These pin the selection maths, because getting it subtly
 * wrong is invisible — the image still renders, just at the wrong size, and
 * the only symptom is a data bill.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  previewUrlForViewport, viewportPreviewWidth, thumbnailUrlForTile, tileThumbnailWidth,
  PREVIEW_WIDTHS,
} from '../imageTiers';

const realWidth = window.innerWidth;
const realDpr = window.devicePixelRatio;

function setViewport(width: number, dpr: number, connection?: unknown, height = 844) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
}

// The lightbox always passes real dimensions; these stand in for a typical
// landscape frame so the tier is chosen from geometry rather than the
// unknown-dimensions fallback.
const LANDSCAPE = { width: 3000, height: 2000 };

afterEach(() => {
  setViewport(realWidth, realDpr, undefined);
  vi.restoreAllMocks();
});

describe('viewportPreviewWidth', () => {
  it('picks the smallest tier that still covers the device', () => {
    setViewport(390, 3);   // 1170 device px on the long edge — a DPR-3 phone
    expect(viewportPreviewWidth(LANDSCAPE)).toBe(1280);

    setViewport(375, 1);   // 375 — an old phone
    expect(viewportPreviewWidth(LANDSCAPE)).toBe(640);

    setViewport(1440, 2, undefined, 900);  // beyond the top tier
    expect(viewportPreviewWidth(LANDSCAPE)).toBe(1920);
  });

  it('never returns a tier smaller than the device needs', () => {
    // Undershooting is the one failure that is actually visible: a blurry
    // lightbox. Overshooting only costs bytes.
    for (const [w, dpr] of [[320, 1], [390, 3], [768, 2], [1024, 1], [1440, 2]] as const) {
      setViewport(w, dpr, undefined, Math.round(w * 2));
      const scale = Math.min(w / LANDSCAPE.width, (w * 2) / LANDSCAPE.height);
      const needed = Math.round(LANDSCAPE.width * scale * Math.min(dpr, 3));
      const picked = viewportPreviewWidth(LANDSCAPE);
      expect(picked >= needed || picked === PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]).toBe(true);
    }
  });

  it('caps devicePixelRatio so an absurd DPR cannot skip straight to the top', () => {
    // Uncapped this would ask for 3900 device px and land on the 1920 tier —
    // i.e. a phone pulling the desktop rendition, which is the bug. Capped at
    // 3 it asks for 1170 and takes 1280, the same as a normal DPR-3 phone.
    setViewport(390, 10);
    expect(viewportPreviewWidth(LANDSCAPE)).toBe(1280);
  });
});

describe('long-edge sizing (the server bounds the LONG edge, not the width)', () => {
  it('gives a portrait photo a bigger tier than a landscape one on the same phone', () => {
    // 390x844 at DPR 3. A 2:3 portrait is bound by height and renders ~1755
    // device px on its long edge; a 3:2 landscape is bound by width and needs
    // ~1170. Sizing from viewport WIDTH alone gives both 1280 and makes every
    // portrait softer than it is today — the regression this guards.
    setViewport(390, 3);
    expect(viewportPreviewWidth({ width: 2000, height: 3000 })).toBe(1920);
    expect(viewportPreviewWidth({ width: 3000, height: 2000 })).toBe(1280);
  });

  it('falls back to the top tier when dimensions are unknown', () => {
    // No geometry to reason about, so serve what is served today rather than
    // guessing small and shipping a blurry lightbox.
    setViewport(390, 3);
    expect(viewportPreviewWidth(undefined)).toBe(1920);
    expect(viewportPreviewWidth({ width: null, height: null })).toBe(1920);
  });
});

describe('previewUrlForViewport', () => {
  it('leaves the URL untouched at the default tier', () => {
    // Byte-identical URLs at 1920 keep every existing cache entry and ETag
    // valid, so desktop users see no change at all.
    setViewport(1920, 2, undefined, 1080);
    expect(previewUrlForViewport('/api/gallery/x/preview/7', LANDSCAPE)).toBe('/api/gallery/x/preview/7');
  });

  it('appends a width below the default tier', () => {
    setViewport(390, 3);
    expect(previewUrlForViewport('/api/gallery/x/preview/7', LANDSCAPE)).toBe('/api/gallery/x/preview/7?w=1280');
  });

  it('preserves an existing query string', () => {
    setViewport(375, 1);
    expect(previewUrlForViewport('/api/gallery/x/preview/7?token=abc', LANDSCAPE))
      .toBe('/api/gallery/x/preview/7?token=abc&w=640');
  });

  it('returns null for a null preview so the caller falls back to the original', () => {
    // A null preview_url means the lightbox is about to serve the untouched
    // original; hanging ?w= on that would claim a resize that never happened.
    setViewport(390, 3);
    expect(previewUrlForViewport(null)).toBeNull();
    expect(previewUrlForViewport(undefined)).toBeNull();
    expect(previewUrlForViewport('')).toBeNull();
  });

  it('downshifts one tier on save-data', () => {
    setViewport(390, 3, { saveData: true });
    expect(previewUrlForViewport('/p', LANDSCAPE)).toBe('/p?w=640');
  });

  it('downshifts one tier on a slow connection', () => {
    setViewport(390, 3, { effectiveType: '3g' });
    expect(previewUrlForViewport('/p', LANDSCAPE)).toBe('/p?w=640');
  });

  it('ignores a healthy connection object', () => {
    setViewport(390, 3, { effectiveType: '4g', saveData: false });
    expect(previewUrlForViewport('/p', LANDSCAPE)).toBe('/p?w=1280');
  });

  it('never downshifts below the smallest tier', () => {
    setViewport(320, 1, { saveData: true }); // already at 640
    expect(previewUrlForViewport('/p', LANDSCAPE)).toBe('/p?w=640');
  });
});

// A source big enough to fill every tier, so the tier comes from the tile
// geometry rather than the short-edge clamp.
const BIG = { width: 4000, height: 3000 };

describe('tileThumbnailWidth', () => {
  it('sizes from the tile, not the viewport', () => {
    // The bug in #1095: a 2-up phone tile is ~195 CSS px, which is 585 device
    // px at DPR 3 — the 300px thumbnail upscaled ~1.9x.
    setViewport(390, 3);
    expect(tileThumbnailWidth(BIG)).toBe(600);

    // Same tile on a DPR-1 phone genuinely only needs 195, so it keeps the
    // small file. Sizing off the viewport alone would have shipped 600 here.
    setViewport(390, 1);
    expect(tileThumbnailWidth(BIG)).toBe(300);

    setViewport(768, 2);   // 3 up -> 256 CSS px -> 512
    expect(tileThumbnailWidth(BIG)).toBe(600);

    setViewport(1920, 2);  // 4 up -> 480 CSS px -> 960, past the top tier
    expect(tileThumbnailWidth(BIG)).toBe(900);
  });

  it('stops at the first tier that already covers the source', () => {
    // generateThumbnail resizes withoutEnlargement, so once a tier exceeds the
    // source every larger one returns the same pixels — for a second Sharp run
    // and a second cache entry holding a byte-identical file.
    setViewport(1920, 2);  // wants 900
    expect(tileThumbnailWidth({ width: 500, height: 400 })).toBe(600);
    expect(tileThumbnailWidth({ width: 260, height: 200 })).toBe(300);
  });

  it('does not drop a tier and throw away source pixels', () => {
    // A 400px short edge fits inside no tier but 300, so clamping to the
    // largest tier it FITS IN would serve 300 and discard 100 real pixels.
    // Asking for 600 returns all 400 of them.
    setViewport(1920, 2);
    expect(tileThumbnailWidth({ width: 500, height: 400 })).not.toBe(300);

    // And a source that comfortably clears 600 is not held back at it.
    expect(tileThumbnailWidth({ width: 800, height: 700 })).toBe(900);
  });

  it('measures the SHORT edge, because thumbnails are square', () => {
    // A 4000x600 panorama has width to spare and can still only fill a 600
    // square. Measuring the long edge would over-ask for every panorama.
    setViewport(1920, 2);
    expect(tileThumbnailWidth({ width: 4000, height: 600 })).toBe(600);
  });

  it('prefers the measured tile over the breakpoint fallback', () => {
    // Mosaic is 1-up on mobile where Grid is 2-up, and thumbnailScale shifts
    // every layout's column count, so the fallback is wrong for most installs
    // whenever a real measurement is available.
    setViewport(390, 3);
    expect(tileThumbnailWidth(BIG)).toBe(600);          // fallback: 2 up
    expect(tileThumbnailWidth(BIG, 390)).toBe(900);     // measured: 1 up
    expect(tileThumbnailWidth(BIG, 96)).toBe(300);      // measured: a dense grid

    // A zero-width measurement is a not-yet-laid-out tile, not a 0px one.
    expect(tileThumbnailWidth(BIG, 0)).toBe(600);
  });

  it('falls back to tile geometry when dimensions are unknown', () => {
    // No guard available; the server clamps with withoutEnlargement anyway, so
    // the worst case is a tier that returns the source size.
    setViewport(390, 3);
    expect(tileThumbnailWidth()).toBe(600);
    expect(tileThumbnailWidth({ width: null, height: null })).toBe(600);
  });
});

describe('thumbnailUrlForTile', () => {
  it('appends the tier the tile needs', () => {
    setViewport(390, 3);
    expect(thumbnailUrlForTile('/api/gallery/x/thumbnail/7', BIG))
      .toBe('/api/gallery/x/thumbnail/7?w=600');
  });

  it('leaves the canonical URL byte-identical', () => {
    // No parameter for the default tier, so existing caches and ETags stay
    // valid for every client that is already holding one.
    setViewport(390, 1);
    expect(thumbnailUrlForTile('/t', BIG)).toBe('/t');
  });

  it('preserves an existing query string', () => {
    setViewport(390, 3);
    expect(thumbnailUrlForTile('/t?wm=1', BIG)).toBe('/t?wm=1&w=600');
  });

  it('downshifts a tier on save-data', () => {
    setViewport(390, 3, { saveData: true });
    expect(thumbnailUrlForTile('/t', BIG)).toBe('/t');
  });

  it('returns null when there is no thumbnail to size', () => {
    // The caller is about to fall back to the original; ?w= on that route
    // means something else entirely.
    expect(thumbnailUrlForTile(null)).toBeNull();
    expect(thumbnailUrlForTile(undefined)).toBeNull();
  });
});
