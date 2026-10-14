/**
 * Card controls the full-page layouts hide with `opacity: 0` (#1263 class).
 *
 * Opacity hides pixels, not hit-testing or focus. Story's card heart had no
 * `pointer-events: none`, so on a touchscreen the invisible top-right corner
 * of every card liked the photo; Premium's checkbox and heart were already
 * untappable but took keyboard focus while invisible. jsdom applies no
 * stylesheets, so these pin the rules in the CSS source itself.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const layouts = path.resolve(process.cwd(), 'src/components/gallery/layouts');
const css = (file: string) => fs.readFileSync(path.join(layouts, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as [selectors, declarations], comments stripped. */
const rules = (source: string) => Array.from(source.matchAll(/([^{}]+)\{([^{}]*)\}/g))
  .map(([, selectors, body]) => [selectors.split(',').map((s) => s.trim()), body] as const);

const declares = (body: string, property: string, value: string) =>
  new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`).test(body);

function ruleFor(source: string, selector: string) {
  return rules(source).filter(([selectors]) => selectors.includes(selector));
}

describe('Story card heart', () => {
  const story = css('GalleryStoryLayout.css');

  it('is not hit-tested while hidden', () => {
    const [base] = ruleFor(story, '.story-photo-card-actions');
    expect(base).toBeDefined();
    expect(declares(base[1], 'opacity', '0')).toBe(true);
    expect(declares(base[1], 'pointer-events', 'none')).toBe(true);
  });

  it.each([
    '.story-photo-card:hover .story-photo-card-actions',
    '.story-photo-card-actions:focus-within',
    "[data-input-mode='touch'] .story-photo-card-actions",
  ])('is shown and tappable on %s', (selector) => {
    const matching = ruleFor(story, selector);
    expect(matching.some(([, body]) => declares(body, 'opacity', '1')
      && declares(body, 'pointer-events', 'auto'))).toBe(true);
  });
});

describe('Premium card controls', () => {
  const premium = css('GalleryPremiumLayout.css');

  it.each(['.gallery-premium-checkbox:focus-visible', '.gallery-premium-like-btn:focus-visible'])(
    'are shown while %s',
    (selector) => {
      const matching = ruleFor(premium, selector);
      expect(matching.some(([, body]) => declares(body, 'opacity', '1'))).toBe(true);
    },
  );
});
