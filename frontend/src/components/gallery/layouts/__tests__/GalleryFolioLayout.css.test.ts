/**
 * Gallery Folio's stylesheet (issue 2617). jsdom applies no stylesheets, so
 * the rules that carry behaviour are pinned in the CSS source: the phone nav
 * (secondary actions leave the row for the menu, the row can shrink instead
 * of running over the way back to the account), the focus ring, reduced
 * motion and the cover's scrim.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../../utils/contrast';

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/components/gallery/layouts/GalleryFolioLayout.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of `selector` inside `@media (<query>)`, or at the top level without a query. */
function declarations(selector: string, query?: string): string {
  // Every block of that query; a top-level rule sits outside all of them.
  const source = query
    ? css.split(`@media (${query})`).slice(1).map((block) => block.split(/\n}\n/)[0]).join('\n')
    : css.replace(/@media[^{]+\{[\s\S]*?\n}\n/g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|[},\\s])${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('Folio nav on a phone', () => {
  it('hides the secondary actions below 640 px and shows them from 640 px', () => {
    expect(declarations('.folio-nav-secondary')).toMatch(/display:\s*none/);
    expect(declarations('.folio-nav-secondary', 'min-width: 640px')).toMatch(/display:\s*inline-flex/);
  });

  it('shows the menu below 640 px only', () => {
    expect(declarations('.folio-nav-more', 'min-width: 640px')).toMatch(/display:\s*none/);
  });

  it('keeps the way back to the account whole and lets the label give way', () => {
    expect(declarations('.folio-nav-back')).toMatch(/flex-shrink:\s*0/);
    expect(declarations('.folio-nav-actions')).not.toMatch(/flex-shrink:\s*0/);
    expect(declarations('.folio-nav-start')).toMatch(/min-width:\s*0/);
  });
});

describe('Folio focus ring', () => {
  it('is drawn in the palette\'s ink, not in the control\'s own colour', () => {
    // An active nav button, the primary pill and the chosen category are
    // filled with the ink and written in the page colour: a ring in
    // currentColor would be the page colour on the page.
    const ring = declarations('.gallery-folio :focus-visible');
    expect(ring).toMatch(/outline:\s*2px solid var\(--color-text\)/);
    expect(ring).not.toMatch(/currentColor/);
  });

  it('stays white on the photographs: the full cover and the tiles', () => {
    expect(declarations('.gallery-folio .folio-cover--full :focus-visible')).toMatch(/outline-color:\s*#fff/);
    expect(declarations('.gallery-folio .folio-tile :focus-visible')).toMatch(/outline:\s*2px solid #fff/);
  });
});

describe('Folio under reduced motion', () => {
  const block = (css.split('@media (prefers-reduced-motion: reduce)')[1] ?? '').split(/\n}\n/)[0];

  it('stills its own transitions and the cover\'s fade', () => {
    expect(block).toContain('.folio-cover-image');
    expect(block).toMatch(/animation:\s*none/);
    expect(block).toMatch(/transition:\s*none/);
  });

  it('leaves the shared components\' animations alone: a spinner still says "working"', () => {
    expect(block).not.toMatch(/\.gallery-folio\s+\*/);
    expect(block).not.toContain('!important');
  });
});

describe('Folio full cover', () => {
  // The scrim's alpha at a height of the cover, 0 at the bottom edge.
  const gradient = declarations('.folio-cover--full .folio-cover-media::after').match(/linear-gradient\(to top,(.*)\)\s*;/s)![1];
  const stops = Array.from(gradient.matchAll(/rgba\(0,\s*0,\s*0,\s*([\d.]+)\)\s+([\d.]+)%/g))
    .map(([, alpha, at]) => ({ alpha: Number(alpha), at: Number(at) }));
  const alphaAt = (height: number) => {
    const next = stops.findIndex((stop) => stop.at >= height);
    if (next <= 0) return stops[Math.max(next, 0)].alpha;
    const [a, b] = [stops[next - 1], stops[next]];
    return a.alpha + ((b.alpha - a.alpha) * (height - a.at)) / (b.at - a.at);
  };
  // White text over a white photograph, the worst case: what the scrim leaves.
  const whiteOnWhitePhoto = (height: number) => {
    const level = Math.round(255 * (1 - alphaAt(height))).toString(16).padStart(2, '0');
    return contrastRatio('#ffffff', `#${level}${level}${level}`);
  };

  it('keeps the small text readable on the brightest photo: 4.5:1 up to a third of its height', () => {
    // The date tops the text block at about 30% on a phone, 28% on a desktop.
    for (const height of [0, 10, 20, 30, 33]) {
      expect(whiteOnWhitePhoto(height)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('fades out above the text, so the upper half of the photo is untouched', () => {
    expect(alphaAt(45)).toBeLessThanOrEqual(0.4);
    expect(stops.at(-1)!.alpha).toBe(0);
    expect(stops.at(-1)!.at).toBeLessThanOrEqual(80);
  });

  it('backs every line of the text with a shadow, not the title alone', () => {
    expect(declarations('.folio-cover--full .folio-cover-text')).toMatch(/text-shadow:/);
  });
});
