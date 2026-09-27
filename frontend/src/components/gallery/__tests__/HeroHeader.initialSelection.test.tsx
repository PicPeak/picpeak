/**
 * The hero is chosen on the first render and fetched ahead of the tiles (#1695).
 *
 * HeroHeader used to start with `heroPhoto = null` and pick one in an effect,
 * so its first commit rendered nothing and the request went out a commit
 * later — after a layout that mounts every tile at once had already queued
 * its thumbnails. Its AuthenticatedImage also used the queue's default
 * priority. On a 266-photo Mosaic the hero was the last image to arrive.
 *
 * Rendered to a string, deliberately: effects never run in renderToString,
 * so a hero present in the markup can only have been selected synchronously.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

import { HeroHeader } from '../HeroHeader';
import type { Photo } from '../../../types';

let heroImageId: number | undefined;
vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { heroImageId } } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: Date) => d.toISOString() }),
}));
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, queuePriority }: { src: string; queuePriority?: string }) => (
    <img data-testid="hero" data-src={src} data-priority={queuePriority ?? 'normal'} alt="" />
  ),
}));
vi.mock('../HeroDivider', () => ({ HeroDivider: () => null }));

const photo = (id: number): Photo => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  hero_url: `/api/gallery/x/hero/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
} as Photo);

const PHOTOS = [photo(1), photo(2), photo(3)];

const hero = (html: string) => {
  const m = html.match(/data-testid="hero" data-src="([^"]+)" data-priority="([^"]+)"/);
  return m ? { src: m[1], priority: m[2] } : null;
};

describe('HeroHeader initial selection', () => {
  it('renders the first photo on the very first render, at high priority', () => {
    heroImageId = undefined;
    const html = renderToString(<HeroHeader photos={PHOTOS} slug="x" />);
    expect(hero(html)).toEqual({ src: '/api/gallery/x/hero/1', priority: 'high' });
  });

  it('honours the admin-selected hero on the first render', () => {
    heroImageId = 3;
    const html = renderToString(<HeroHeader photos={PHOTOS} slug="x" />);
    expect(hero(html)?.src).toBe('/api/gallery/x/hero/3');
  });

  it('takes an override on the first render', () => {
    heroImageId = 3;
    const html = renderToString(<HeroHeader photos={PHOTOS} slug="x" heroPhotoOverride={photo(2)} />);
    expect(hero(html)?.src).toBe('/api/gallery/x/hero/2');
  });

  it('renders nothing for an empty gallery', () => {
    heroImageId = undefined;
    expect(hero(renderToString(<HeroHeader photos={[]} slug="x" />))).toBeNull();
  });
});
