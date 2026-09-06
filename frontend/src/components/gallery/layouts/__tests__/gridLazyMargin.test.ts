/**
 * Grid's lazy-loading pre-load band (#1287).
 *
 * Grid was the only layout passing `lazy` without an `inViewRootMargin`, so
 * PhotoCard ran its observer at the IntersectionObserver default of `0px`
 * with `threshold: 0.1` — a tile could not begin loading until a tenth of it
 * was already on screen. The gallery owner described exactly that: spinning
 * the scroll wheel outran loading by ~50 images before it caught up.
 *
 * The unit matters as much as the value. `rootMargin` accepts only px and
 * percentages; an IntersectionObserver constructed with a `vh` value throws
 * SyntaxError, which would have broken every Grid gallery outright. Verified
 * in Chrome:
 *
 *   '100% 0px'  → accepted
 *   '100px 0px' → accepted
 *   '100vh 0px' → SyntaxError: rootMargin must be specified in pixels or percent
 *
 * jsdom has no IntersectionObserver, so this asserts against the source
 * rather than constructing one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const layouts = resolve(__dirname, '..');
const read = (f: string) => readFileSync(resolve(layouts, f), 'utf8');

/** Only px and % are legal rootMargin units. */
const LEGAL_ROOT_MARGIN = /^(-?\d+(px|%)|0)(\s+(-?\d+(px|%)|0)){0,3}$/;

describe('grid lazy pre-load band', () => {
  it('Grid passes an inViewRootMargin', () => {
    expect(read('GridGalleryLayout.tsx')).toMatch(/inViewRootMargin=/);
  });

  it('every inViewRootMargin in every layout uses a legal unit', () => {
    // A vh value throws at IntersectionObserver construction and takes the
    // whole gallery down with it, so this guards the unit, not just presence.
    for (const file of ['GridGalleryLayout.tsx', 'JustifiedGalleryLayout.tsx']) {
      const src = read(file);
      for (const [, value] of src.matchAll(/inViewRootMargin="([^"]+)"/g)) {
        expect(value, `${file}: "${value}"`).toMatch(LEGAL_ROOT_MARGIN);
      }
    }
  });

  it('Grid releases what it loaded, and the outer band is legal and wider', () => {
    // The pre-load band fixed tiles arriving late; it did nothing about them
    // never leaving. Measured in Chrome on a seeded 546-photo grid: without a
    // release band the mounted count climbs 24 → 100 → 212 → 364 → 546 and
    // never falls, because a tile that has been scrolled past keeps its object
    // URL and any protection canvas for the life of the page. With it the peak
    // is 68.
    const src = read('GridGalleryLayout.tsx');
    const release = src.match(/releaseRootMargin="([^"]+)"/);
    expect(release, 'Grid declares no releaseRootMargin').toBeTruthy();
    expect(release![1]).toMatch(LEGAL_ROOT_MARGIN);

    // The gap between the bands is the hysteresis. If the outer band were not
    // strictly wider, a tile would be released and immediately reloaded on
    // every scroll across the edge.
    const load = src.match(/inViewRootMargin="([^"]+)"/);
    const percent = (value: string) => Number(value.split(/\s+/)[0].replace('%', ''));
    expect(percent(release![1])).toBeGreaterThan(percent(load![1]));
  });

  it('every layout that lazy-renders also declares a pre-load band', () => {
    // The defect was Grid being lazy with no margin. Any future layout that
    // opts into `lazy` and forgets the margin reintroduces it.
    for (const file of ['GridGalleryLayout.tsx', 'JustifiedGalleryLayout.tsx']) {
      const src = read(file);
      const isLazy = /^\s*lazy\s*$/m.test(src) || /\slazy=\{?true/.test(src);
      if (!isLazy) continue;
      expect(src, `${file} is lazy but declares no inViewRootMargin`)
        .toMatch(/inViewRootMargin=/);
    }
  });
});
