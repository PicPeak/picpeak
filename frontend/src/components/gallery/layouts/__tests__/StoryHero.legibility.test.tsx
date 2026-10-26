/**
 * Issue 1708: the Story hero title used `mix-blend-mode: overlay`, so over a
 * mid-toned or busy hero image it could vanish. Legibility now comes from a
 * scrim behind the copy and a text shadow, neither of which depends on the
 * pixels underneath. jsdom cannot measure contrast, so this pins the
 * stylesheet contract and that the title renders inside the scrim over both a
 * light and a dark hero photo.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StoryHero } from '../story/StoryHero';
import type { Photo } from '../../../../types';

vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className }, ref) =>
      React.createElement(tag, { ref, className }, children as React.ReactNode)
    );
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= stub(tag)),
    }),
  };
});

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));

// Comments explain the fix and mention the old property, so they are not part
// of the contract under test.
const rawCss = readFileSync(
  resolve(process.cwd(), 'src/components/gallery/layouts/GalleryStoryLayout.css'),
  'utf8'
);
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration block for a selector list that contains `selector`. */
function blocksFor(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    if (match[1].split(',').map((s) => s.trim()).includes(selector)) out.push(match[2]);
  }
  return out;
}

const heroPhoto = (id: number, tone: 'light' | 'dark'): Photo => ({
  id,
  filename: `${tone}-hero.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  hero_url: `/api/gallery/x/hero/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
} as Photo);

describe('Story hero title legibility (issue 1708)', () => {
  it('no longer blends the title into the hero image', () => {
    const titleBlocks = blocksFor('.story-hero-title');
    expect(titleBlocks.length).toBeGreaterThan(0);
    for (const block of titleBlocks) expect(block).not.toMatch(/mix-blend-mode/);
    expect(css).not.toMatch(/mix-blend-mode/);
  });

  it('gives the title an opaque colour and a shadow that do not depend on the image', () => {
    const base = blocksFor('.story-hero-title')[0];
    expect(base).toMatch(/color:\s*#fff/i);
    expect(base).toMatch(/text-shadow:/);
  });

  it('puts a localised scrim behind the copy', () => {
    const scrim = blocksFor('.story-hero-copy::before');
    expect(scrim.length).toBe(1);
    expect(scrim[0]).toMatch(/radial-gradient/);
    expect(scrim[0]).toMatch(/rgba\(0,\s*0,\s*0,\s*0\.\d+\)/);
  });

  // Issue 2254: a scrim painted as the copy box's own background ended on
  // that box, still partly dark halfway along each side, so its edge showed
  // on detailed images. The pixel check is tests/e2e/story-hero-scrim.spec.ts.
  it('feathers the scrim out past the copy box instead of cutting it off there', () => {
    const copy = blocksFor('.story-hero-copy');
    expect(copy.length).toBe(1);
    expect(copy[0]).not.toMatch(/background/);
    expect(copy[0]).toMatch(/isolation:\s*isolate/);

    const scrim = blocksFor('.story-hero-copy::before')[0];
    expect(scrim).toMatch(/inset:\s*-\d/);
    expect(scrim).toMatch(/z-index:\s*-1/);
    expect(scrim).toMatch(/pointer-events:\s*none/);
    // Both edges of both axes fade to transparent, prefixed and unprefixed.
    for (const prop of ['-webkit-mask-image', 'mask-image']) {
      const value = scrim.match(new RegExp(`(?:^|[;\\s])${prop}:([^;]*);`))?.[1] ?? '';
      expect(value, prop).toMatch(/to right[\s\S]*to bottom/);
      expect(value.match(/transparent 0,/g), prop).toHaveLength(2);
      expect(value.match(/transparent 100%/g), prop).toHaveLength(2);
    }
    expect(scrim).toMatch(/-webkit-mask-composite:\s*source-in/);
    expect(scrim).toMatch(/(?:^|[;\s])mask-composite:\s*intersect/);
  });

  it.each(['light', 'dark'] as const)('renders the title inside the scrim over a %s hero photo', (tone) => {
    const { container } = render(
      <StoryHero title="Sarah & Tom" stats="12 Photos" photo={heroPhoto(1, tone)} slug="x" />
    );
    const title = container.querySelector('h1.story-hero-title');
    expect(title).not.toBeNull();
    expect(title?.textContent).toBe('Sarah & Tom');
    expect(title?.closest('.story-hero-copy')).not.toBeNull();
    expect(container.querySelector('.story-hero-gradient')).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`/api/gallery/x/hero/1`);
  });
});
