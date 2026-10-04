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
 *
 * Since issue 1733 the layouts no longer write the bands as percentages:
 * `rootMargin` percentages resolve against the root's WIDTH on every side,
 * so `100% 0px` was under half a screen on a portrait phone. They take
 * `useLazyBands()` (lazyBands.ts), which converts viewport heights to px.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { lazyBands, LOAD_BAND_VIEWPORTS, KEEP_BAND_VIEWPORTS } from '../lazyBands';

const layouts = resolve(__dirname, '..');
const read = (f: string) => readFileSync(resolve(layouts, f), 'utf8');

/** Only px and % are legal rootMargin units. */
const LEGAL_ROOT_MARGIN = /^(-?\d+(px|%)|0)(\s+(-?\d+(px|%)|0)){0,3}$/;

/** Every layout that funnels its tiles through PhotoCard. */
const PHOTO_CARD_LAYOUTS = [
  'GridGalleryLayout.tsx',
  'JustifiedGalleryLayout.tsx',
  'MosaicGalleryLayout.tsx',
  'MasonryGalleryLayout.tsx',
  'TimelineGalleryLayout.tsx',
];

describe('grid lazy pre-load band', () => {
  it('Grid passes an inViewRootMargin', () => {
    expect(read('GridGalleryLayout.tsx')).toMatch(/inViewRootMargin=/);
  });

  it('every band in every layout is a literal with a legal unit or comes from useLazyBands', () => {
    // A vh value throws at IntersectionObserver construction and takes the
    // whole gallery down with it, so this guards the unit, not just presence.
    // A percentage is legal but means width, so the shared helper is the
    // expected form (issue 1733).
    for (const file of PHOTO_CARD_LAYOUTS) {
      const src = read(file);
      for (const [, value] of src.matchAll(/(?:inView|release)RootMargin="([^"]+)"/g)) {
        expect(value, `${file}: "${value}"`).toMatch(LEGAL_ROOT_MARGIN);
        expect(value, `${file}: "${value}" is width-relative; use useLazyBands()`).not.toMatch(/%/);
      }
      for (const [, value] of src.matchAll(/(?:inView|release)RootMargin=\{([^}]+)\}/g)) {
        expect(value, `${file}: {${value}}`).toMatch(/^bands\.(load|keep)$/);
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
    expect(src).toMatch(/releaseRootMargin=\{bands\.keep\}/);
    expect(src).toMatch(/inViewRootMargin=\{bands\.load\}/);
    expect(src).toMatch(/const bands = useLazyBands\(\)/);

    // The gap between the bands is the hysteresis. If the outer band were not
    // strictly wider, a tile would be released and immediately reloaded on
    // every scroll across the edge.
    const { load, keep } = lazyBands(844);
    expect(load).toMatch(LEGAL_ROOT_MARGIN);
    expect(keep).toMatch(LEGAL_ROOT_MARGIN);
    const px = (value: string) => Number(value.split(/\s+/)[0].replace('px', ''));
    expect(px(keep)).toBeGreaterThan(px(load));
  });

  it('the bands are viewport heights in px, not percentages of the width', () => {
    // IntersectionObserver resolves every rootMargin percentage against the
    // root's width, top and bottom included: `100% 0px` on a 390×844 phone
    // preloaded 390px, under half a screen.
    expect(lazyBands(844)).toEqual({ load: '844px 0px', keep: '2532px 0px' });
    expect(lazyBands(390)).toEqual({ load: '400px 0px', keep: '1200px 0px' }); // floor for tiny/0 heights
    expect(lazyBands(0).load).toBe('400px 0px');
    expect(KEEP_BAND_VIEWPORTS).toBeGreaterThan(LOAD_BAND_VIEWPORTS);
  });

  it('Mosaic is lazy and releases, with the same bands as Grid', () => {
    // #1695. Mosaic passed `loading: 'lazy'` on the <img> and nothing to
    // PhotoCard, but AuthenticatedImage fetches in an effect the moment it
    // mounts, so the attribute deferred nothing: every tile of a 266-photo
    // gallery entered the fetch queue on first render, ahead of the hero.
    // Mosaic's tile carries an explicit aspectRatio, so it can release like
    // Grid without reflowing.
    const mosaic = read('MosaicGalleryLayout.tsx');
    const grid = read('GridGalleryLayout.tsx');
    expect(/^\s*lazy\s*$/m.test(mosaic)).toBe(true);
    const band = (src: string, name: string) => src.match(new RegExp(`${name}=\\{([^}]+)\\}`))?.[1];
    expect(band(mosaic, 'inViewRootMargin')).toBe(band(grid, 'inViewRootMargin'));
    expect(band(mosaic, 'releaseRootMargin')).toBe(band(grid, 'releaseRootMargin'));
  });

  it('every layout that lazy-renders also declares a pre-load band', () => {
    // The defect was Grid being lazy with no margin. Any future layout that
    // opts into `lazy` and forgets the margin reintroduces it.
    for (const file of PHOTO_CARD_LAYOUTS) {
      const src = read(file);
      const isLazy = /^\s*lazy\s*$/m.test(src) || /\slazy=\{?true/.test(src);
      if (!isLazy) continue;
      expect(src, `${file} is lazy but declares no inViewRootMargin`)
        .toMatch(/inViewRootMargin=/);
    }
  });

  it('Masonry, Timeline and Justified are lazy and release too (issue 1733)', () => {
    // These three mounted every tile on first render, so a 500-photo gallery
    // put 500 fetches in the queue before the first row was on screen, and
    // kept all 500 for the life of the page. Each sizes its tile from the
    // stored dimensions, so releasing cannot reflow. Masonry has four modes
    // and every one of them renders a PhotoCard; all four must opt in.
    const grid = read('GridGalleryLayout.tsx');
    const release = grid.match(/releaseRootMargin=\{([^}]+)\}/)![1];
    for (const file of ['MasonryGalleryLayout.tsx', 'TimelineGalleryLayout.tsx', 'JustifiedGalleryLayout.tsx']) {
      const src = read(file);
      const cards = src.match(/<(?:PhotoCard|MasonryPhoto|JustifiedPhoto)\b/g)!.length;
      const lazies = src.match(/^\s*lazy\s*$/mg)?.length ?? 0;
      const releases = src.match(/releaseRootMargin=\{([^}]+)\}/g) ?? [];
      // Every card site in the file, less the one inner component that
      // forwards to PhotoCard (MasonryPhoto, JustifiedPhoto) declares both.
      const sites = cards - (/\b(?:MasonryPhoto|JustifiedPhoto)\b/.test(src) ? 1 : 0);
      expect(lazies, `${file}: lazy on ${lazies} of ${sites} card sites`).toBe(sites);
      expect(releases.length, `${file}: releaseRootMargin on ${releases.length} of ${sites} card sites`).toBe(sites);
      for (const r of releases) expect(r).toBe(`releaseRootMargin={${release}}`);
    }
  });

  it('content-visibility goes on explicit boxes outside CSS columns only', () => {
    // Issue 1733: a released tile still costs style, layout and paint on
    // every scroll frame; `content-visibility: auto` skips all three for
    // far-off tiles. Only safe where the box does not depend on the
    // contents, which every PhotoCard layout but one guarantees. Mosaic
    // stays out because Safari mis-balances CSS columns of skipped content,
    // and Masonry's columns mode because its tile owns a `position: fixed`
    // modal that layout containment would trap inside the tile.
    for (const file of ['GridGalleryLayout.tsx', 'JustifiedGalleryLayout.tsx', 'TimelineGalleryLayout.tsx']) {
      expect(read(file), `${file} declares no contentVisibility`).toMatch(/contentVisibility: 'auto'/);
    }
    expect(read('MosaicGalleryLayout.tsx')).not.toMatch(/contentVisibility/);

    // Masonry: three of four modes (rows, flickr, quilted); the columns-mode
    // card (`MasonryPhoto`) must not.
    const masonry = read('MasonryGalleryLayout.tsx');
    expect(masonry.match(/contentVisibility: 'auto'/g)).toHaveLength(3);
    const masonryPhoto = masonry.slice(masonry.indexOf('const MasonryPhoto'), masonry.indexOf('export const MasonryGalleryLayout'));
    expect(masonryPhoto).not.toMatch(/contentVisibility/);
  });

  it('the columns-mode placeholder does not animate', () => {
    // Without content-visibility a released MasonryPhoto still paints every
    // frame, and the default `.skeleton` is `animate-pulse`: hundreds of
    // far-off tiles would run an infinite opacity animation for the life
    // of the page, undoing what releasing them saved (issue 1733).
    const masonry = read('MasonryGalleryLayout.tsx');
    const masonryPhoto = masonry.slice(masonry.indexOf('const MasonryPhoto'), masonry.indexOf('export const MasonryGalleryLayout'));
    const skeleton = masonryPhoto.match(/skeletonClassName="([^"]+)"/);
    expect(skeleton, 'MasonryPhoto relies on the animated default skeleton').toBeTruthy();
    expect(skeleton![1]).not.toMatch(/\bskeleton\b|animate-/);
  });
});
