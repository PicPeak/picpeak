/**
 * Story cards and videos (issue 2284). A card rendered lightboxImageUrl,
 * which falls back to `url` when a photo has no preview or slideshow tier,
 * and a video has neither: every Story video card fetched the clip itself as
 * an image and showed no poster. A video card now shows its poster
 * (thumbnail_url) and the same Video badge the other layouts carry.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

import { StoryPhotoCard } from '../story/StoryPhotoCard';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className, onClick }, ref) =>
      React.createElement(tag, { ref, className, onClick }, children as React.ReactNode)
    );
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= stub(tag)),
    }),
    useInView: () => true,
  };
});

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));

const photo = (id: number, extra: Partial<Photo> = {}): Photo => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  slideshow_url: `/api/gallery/x/preview/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 3000,
  height: 2000,
  ...extra,
} as Photo);

// A video has no preview tier: the server sends null for both derivatives.
const videoFields = { slideshow_url: null, preview_url: null } as Partial<Photo>;

const card = (p: Photo) => render(
  <StoryPhotoCard photo={p} index={0} isFavorite={false} onToggleFavorite={() => {}} slug="x" galleryId="g" />,
).container;

describe('StoryPhotoCard and videos (issue 2284)', () => {
  it.each([
    ['by media type', { media_type: 'video', mime_type: 'video/mp4' }],
    ['by MIME type alone', { media_type: 'image', mime_type: 'video/quicktime' }],
  ] as const)('shows a video %s by its poster, never the clip, with the badge', (_label, kind) => {
    const container = card(photo(2, { ...videoFields, ...kind } as Partial<Photo>));
    expect(container.querySelector('a img')?.getAttribute('src')).toBe('/api/gallery/x/thumbnail/2');
    expect(container.querySelector('[data-testid="story-video-badge"]')).not.toBeNull();
  });

  it('keeps a photo on its preview tier, without the badge', () => {
    const container = card(photo(1));
    expect(container.querySelector('a img')?.getAttribute('src')).toMatch(/^\/api\/gallery\/x\/preview\/1/);
    expect(container.querySelector('[data-testid="story-video-badge"]')).toBeNull();
  });
});
