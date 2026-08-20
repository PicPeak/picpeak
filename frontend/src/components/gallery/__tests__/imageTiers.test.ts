/**
 * Preview tier selection (#1095).
 *
 * The point of the feature is that a phone stops pulling a 1920px rendition it
 * cannot display. These pin the selection maths, because getting it subtly
 * wrong is invisible — the image still renders, just at the wrong size, and
 * the only symptom is a data bill.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import { previewUrlForViewport, viewportPreviewWidth, PREVIEW_WIDTHS } from '../imageTiers';

const realWidth = window.innerWidth;
const realDpr = window.devicePixelRatio;

function setViewport(width: number, dpr: number, connection?: unknown) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
}

afterEach(() => {
  setViewport(realWidth, realDpr, undefined);
  vi.restoreAllMocks();
});

describe('viewportPreviewWidth', () => {
  it('picks the smallest tier that still covers the device', () => {
    setViewport(390, 3);   // 1170 device px — a DPR-3 phone
    expect(viewportPreviewWidth()).toBe(1280);

    setViewport(375, 1);   // 375 — an old phone
    expect(viewportPreviewWidth()).toBe(640);

    setViewport(1440, 2);  // 2880 — beyond the top tier
    expect(viewportPreviewWidth()).toBe(1920);
  });

  it('never returns a tier smaller than the device needs', () => {
    // Undershooting is the one failure that is actually visible: a blurry
    // lightbox. Overshooting only costs bytes.
    for (const [w, dpr] of [[320, 1], [390, 3], [768, 2], [1024, 1], [1440, 2]] as const) {
      setViewport(w, dpr);
      const needed = Math.round(w * Math.min(dpr, 3));
      const picked = viewportPreviewWidth();
      expect(picked >= needed || picked === PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]).toBe(true);
    }
  });

  it('caps devicePixelRatio so an absurd DPR cannot skip straight to the top', () => {
    // Uncapped this would ask for 3900 device px and land on the 1920 tier —
    // i.e. a phone pulling the desktop rendition, which is the bug. Capped at
    // 3 it asks for 1170 and takes 1280, the same as a normal DPR-3 phone.
    setViewport(390, 10);
    expect(viewportPreviewWidth()).toBe(1280);
  });
});

describe('previewUrlForViewport', () => {
  it('leaves the URL untouched at the default tier', () => {
    // Byte-identical URLs at 1920 keep every existing cache entry and ETag
    // valid, so desktop users see no change at all.
    setViewport(1920, 2);
    expect(previewUrlForViewport('/api/gallery/x/preview/7')).toBe('/api/gallery/x/preview/7');
  });

  it('appends a width below the default tier', () => {
    setViewport(390, 3);
    expect(previewUrlForViewport('/api/gallery/x/preview/7')).toBe('/api/gallery/x/preview/7?w=1280');
  });

  it('preserves an existing query string', () => {
    setViewport(375, 1);
    expect(previewUrlForViewport('/api/gallery/x/preview/7?token=abc'))
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
    expect(previewUrlForViewport('/p')).toBe('/p?w=640');
  });

  it('downshifts one tier on a slow connection', () => {
    setViewport(390, 3, { effectiveType: '3g' });
    expect(previewUrlForViewport('/p')).toBe('/p?w=640');
  });

  it('ignores a healthy connection object', () => {
    setViewport(390, 3, { effectiveType: '4g', saveData: false });
    expect(previewUrlForViewport('/p')).toBe('/p?w=1280');
  });

  it('never downshifts below the smallest tier', () => {
    setViewport(320, 1, { saveData: true }); // already at 640
    expect(previewUrlForViewport('/p')).toBe('/p?w=640');
  });
});
