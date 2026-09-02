/**
 * The Story theme routes ALL feedback through its own PhotoLightbox.
 *
 * It used to also render a `StoryFeedbackSheet`, but the only setter for the
 * state that opened it was never called, so the sheet was unreachable — a
 * second, weaker feedback surface (local-only comments, never fetched from the
 * server, no allow_comments/allow_ratings gating) shadowing the lightbox's.
 * The sheet was removed; this pins the layout to the lightbox-only shape the
 * Premium theme also uses, so the dead surface cannot come back unnoticed.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

// framer-motion's useInView needs IntersectionObserver, and the animation
// props would leak onto the DOM node.
vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className, onClick }, ref) =>
      React.createElement(tag, { ref, className, onClick }, children as React.ReactNode)
    );
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= stub(tag)),
    }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useInView: () => true,
  };
});

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  PoweredBy: () => null,
}));

vi.mock('../../PhotoLightbox', () => ({
  PhotoLightbox: ({ feedbackEnabled, initialIndex }: { feedbackEnabled?: boolean; initialIndex: number }) => (
    <div
      data-testid="lightbox"
      data-feedback-enabled={String(!!feedbackEnabled)}
      data-index={String(initialIndex)}
    />
  ),
}));

const submitFeedback = vi.fn().mockResolvedValue({});
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: (...args: unknown[]) => submitFeedback(...args) },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));

const photos: Photo[] = [1, 2, 3].map((i) => ({
  id: i,
  filename: `IMG_${i}.jpg`,
  url: `/api/gallery/x/photo/${i}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
} as Photo));

const props = {
  photos,
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
  feedbackEnabled: true,
  feedbackOptions: { requireNameEmail: true, allowComments: true, allowRatings: true },
} as never;

describe('GalleryStoryLayout — feedback lives in the lightbox only', () => {
  it('renders no feedback sheet even with feedback fully enabled', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);

    expect(container.querySelector('.story-feedback-sheet')).toBeNull();
    expect(container.querySelector('.story-backdrop')).toBeNull();
    expect(screen.queryByText('Rate this moment')).toBeNull();
    expect(screen.queryByPlaceholderText('Write a lovely note...')).toBeNull();
  });

  it('gives each card a like button and nothing else — no per-card feedback affordance', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);

    const actions = container.querySelectorAll('.story-photo-card-actions');
    expect(actions.length).toBe(photos.length);
    actions.forEach((row) => expect(row.querySelectorAll('button')).toHaveLength(1));
  });

  it('opens the lightbox with feedback enabled when a card is clicked', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);

    expect(screen.queryByTestId('lightbox')).toBeNull();
    fireEvent.click(container.querySelector('a[data-photo-id="2"]')!);

    const lightbox = screen.getByTestId('lightbox');
    expect(lightbox.getAttribute('data-feedback-enabled')).toBe('true');
    expect(lightbox.getAttribute('data-index')).toBe('1');
  });

  it('keeps no unreachable feedback state in the source', () => {
    const layouts = path.resolve(process.cwd(), 'src/components/gallery/layouts');

    const layout = fs.readFileSync(path.join(layouts, 'GalleryStoryLayout.tsx'), 'utf8');
    expect(layout).not.toMatch(/StoryFeedbackSheet|selectedPhotoForFeedback/);

    const storyIndex = fs.readFileSync(path.join(layouts, 'story/index.ts'), 'utf8');
    expect(storyIndex).not.toMatch(/StoryFeedbackSheet/);
    expect(fs.existsSync(path.join(layouts, 'story/StoryFeedbackSheet.tsx'))).toBe(false);
  });
});
