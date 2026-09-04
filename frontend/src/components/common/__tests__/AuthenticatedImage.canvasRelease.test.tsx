/**
 * Canvas-mode memory release (#1287).
 *
 * In canvas mode the component keeps a detached `Image` in `imageRef` so
 * `drawToCanvas` can read it. The effect cleanup nulled `onload`/`onerror`
 * but never cleared that ref, so the Image — and the decoded bitmap behind
 * it — stayed pinned by a live JS reference for the component's lifetime.
 *
 * That is not academic at gallery scale. The photo grid is NOT virtualised:
 * a 546-photo event mounts 546 of these and none ever unmount, so nothing was
 * ever released. A decoded <img> in the document is evictable under memory
 * pressure; one held by a ref is not.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/galleryAuthStorage', () => ({
  getActiveGallerySlug: () => 'demo',
  getGalleryToken: () => 'token',
  inferGallerySlugFromLocation: () => 'demo',
  resolveSlugFromRequestUrl: () => 'demo',
}));
vi.mock('../../../utils/url', () => ({ buildResourceUrl: (u: string) => `http://localhost${u}` }));

import { AuthenticatedImage } from '../AuthenticatedImage';

/** Every Image the component constructs, so the test can inspect them. */
const created: HTMLImageElement[] = [];
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(['x'], { type: 'image/png' }),
  })));
  // Patch the two methods rather than replacing URL — spreading the
  // constructor loses its prototype and breaks every `new URL(...)`.
  // Unique per call: the canvas effect keys off `imageSrc`, so a constant
  // URL would make a src change look like no change at all.
  let n = 0;
  createObjectURL = vi.fn(() => `blob:mock-url-${++n}`);
  revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

  const RealImage = globalThis.Image;
  vi.stubGlobal('Image', class extends RealImage {
    constructor() {
      super();
      created.push(this as unknown as HTMLImageElement);
      // jsdom never fires load for a blob: src, so drive it manually.
      setTimeout(() => this.onload?.(new Event('load')), 0);
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('AuthenticatedImage canvas mode', () => {
  it('releases the decoded image on unmount', async () => {
    const { unmount } = render(
      <AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" useCanvasRendering />
    );

    await waitFor(() => expect(created.length).toBeGreaterThan(0));
    const img = created[0];

    unmount();

    // The src is dropped so the browser can reclaim the decode without
    // waiting for GC, and the handlers are detached.
    expect(img.getAttribute('src')).toBeNull();
    expect(img.onload).toBeNull();
    expect(img.onerror).toBeNull();
  });

  it('revokes the blob URL on unmount', async () => {
    const { unmount } = render(
      <AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" useCanvasRendering />
    );

    await waitFor(() => expect(created.length).toBeGreaterThan(0));
    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url-1');
  });

  it('releases the previous image when the src changes', async () => {
    // A recycled tile (a layout reusing a component instance for a different
    // photo) must not accumulate one pinned decode per photo it has shown.
    const { rerender } = render(
      <AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" useCanvasRendering />
    );
    await waitFor(() => expect(created.length).toBe(1));
    const first = created[0];

    rerender(<AuthenticatedImage src="/api/gallery/demo/thumbnail/2" alt="t" useCanvasRendering />);
    await waitFor(() => expect(created.length).toBe(2));

    expect(first.getAttribute('src')).toBeNull();
  });
});
