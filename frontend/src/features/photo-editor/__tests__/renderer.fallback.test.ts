/**
 * The preview's fallback (issue 2619): a canvas that handed out a WebGL
 * context gives no 2D one, so when the GPU set-up fails after the context
 * was created the 2D preview needs a canvas of its own; with no way to draw
 * at all the renderer says so instead of drawing nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditRenderer } from '../renderer';

const contexts = new WeakMap<HTMLCanvasElement, string>();
let allow2d = true;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string, options?: any) {
    const had = contexts.get(this);
    if (had && had !== kind) return null;
    contexts.set(this, kind);
    if (kind === '2d') {
      // The source is always read through a 2D canvas; the preview's own
      // 2D context is what `allow2d` switches off.
      if (!allow2d && !options?.willReadFrequently) return null;
      return {
        drawImage() {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      } as any;
    }
    return { getExtension: () => null } as any;
  } as any);
  vi.spyOn(EditRenderer.prototype as any, 'initGl').mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  allow2d = true;
});

const image = { width: 4, height: 2 } as unknown as ImageBitmap;

describe('EditRenderer fallback', () => {
  it('draws in 2D on a fresh canvas when WebGL set-up fails', () => {
    const renderer = new EditRenderer(image);
    expect(renderer.backend).toBe('canvas');
    expect(contexts.get(renderer.canvas)).toBe('2d');
  });

  it('throws when no way to draw works', () => {
    allow2d = false;
    expect(() => new EditRenderer(image)).toThrow(/cannot draw/);
  });
});
