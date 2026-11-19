/**
 * Chapter markers (issue 2548). Heading (falling back to the category name),
 * then "time · location", then the subheading; a real heading with an id
 * anchor; 'hero' puts the category's hero photo behind the text and falls
 * back to the divider without one; the time follows the viewer's locale;
 * every value is rendered as text. In the Story layout a scene shows its
 * category's marker only while the gallery has them on.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import { StoryChapterMarker, chapterAnchorId, formatChapterTime } from '../story/StoryChapterMarker';
import type { ChapterMarkerText, Photo, PhotoCategory } from '../../../../types';

const i18nState = vi.hoisted(() => ({ language: 'en' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: i18nState,
  }),
}));

vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className, onClick, style }, ref) =>
      React.createElement(tag, { ref, className, onClick, style }, children as React.ReactNode)
    );
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= stub(tag)),
    }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useInView: () => true,
  };
});

vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children?: React.ReactNode }) => <div data-testid="swiper">{children}</div>,
  SwiperSlide: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/modules', () => ({ FreeMode: {}, Mousewheel: {} }));
vi.mock('swiper/css', () => ({}));
vi.mock('swiper/css/free-mode', () => ({}));

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) => (
    <img src={src} alt={alt} className={className} />
  ),
  PoweredBy: () => null,
}));
vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => <div data-testid="lightbox" /> }));
vi.mock('../../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));

const photo = (id: number, categoryId: number, categoryName: string): Photo => ({
  id,
  filename: `photo-${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  hero_url: `/api/gallery/x/hero/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_id: categoryId,
  category_name: categoryName,
  width: 3000,
  height: 2000,
} as Photo);

const category = { id: 7, slug: 'ceremony', name: 'Trauung' };
const full: ChapterMarkerText = {
  heading: 'Die Trauung',
  subheading: 'Treffen mit den Ja-Sagern',
  time: '12:00',
  location: 'Standesamt Hintertupfingen',
};

const text = (el: Element | null) => el?.textContent ?? null;

describe('StoryChapterMarker', () => {
  beforeEach(() => { i18nState.language = 'en'; });

  it('renders heading, then time · location, then subheading as a divider', () => {
    i18nState.language = 'de';
    const { container } = render(
      <StoryChapterMarker category={category} chapter={full} variant="divider" slug="x" />
    );
    const marker = container.querySelector('.story-chapter') as HTMLElement;
    expect(marker.dataset.chapterStyle).toBe('divider');
    expect(marker.querySelector('img')).toBeNull();
    const parts = [...marker.querySelectorAll('.story-chapter-text > *')].map((el) => [el.tagName, el.textContent]);
    expect(parts).toEqual([
      ['H2', 'Die Trauung'],
      ['P', '12:00 · Standesamt Hintertupfingen'],
      ['P', 'Treffen mit den Ja-Sagern'],
    ]);
    expect(marker.querySelector('time')?.getAttribute('datetime')).toBe('12:00');
  });

  it('is a real heading with an anchor id', () => {
    const { container } = render(
      <StoryChapterMarker category={category} chapter={full} variant="divider" slug="x" />
    );
    expect(container.querySelector('h2')?.id).toBe('chapter-ceremony');
    expect(chapterAnchorId({ id: 12, slug: '' })).toBe('chapter-12');
  });

  it('falls back to the category name and leaves out empty lines', () => {
    const { container } = render(
      <StoryChapterMarker
        category={category}
        chapter={{ heading: null, subheading: null, time: null, location: 'Kirche' }}
        variant="divider"
        slug="x"
      />
    );
    expect(text(container.querySelector('h2'))).toBe('Trauung');
    expect(text(container.querySelector('.story-chapter-meta'))).toBe('Kirche');
    expect(container.querySelector('.story-chapter-subheading')).toBeNull();
  });

  it('puts the hero photo behind the text in hero style', () => {
    const { container } = render(
      <StoryChapterMarker
        category={category}
        chapter={full}
        variant="hero"
        heroPhoto={photo(3, 7, 'Trauung')}
        slug="x"
      />
    );
    const marker = container.querySelector('.story-chapter') as HTMLElement;
    expect(marker.dataset.chapterStyle).toBe('hero');
    expect(marker.querySelector('.story-chapter-bg img')?.getAttribute('src')).toBe('/api/gallery/x/hero/3');
    expect(text(marker.querySelector('h2'))).toBe('Die Trauung');
  });

  it('falls back to the divider when the category has no hero photo', () => {
    const { container } = render(
      <StoryChapterMarker category={category} chapter={full} variant="hero" heroPhoto={null} slug="x" />
    );
    const marker = container.querySelector('.story-chapter') as HTMLElement;
    expect(marker.dataset.chapterStyle).toBe('divider');
    expect(marker.querySelector('img')).toBeNull();
  });

  it('renders markup as text, never as HTML', () => {
    const { container } = render(
      <StoryChapterMarker
        category={category}
        chapter={{ heading: '<img src=x onerror=alert(1)>', subheading: '<b>bold</b>', time: null, location: null }}
        variant="divider"
        slug="x"
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(text(container.querySelector('h2'))).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('formatChapterTime', () => {
  it('formats the wall-clock time per locale', () => {
    expect(formatChapterTime('12:00', 'de')).toBe('12:00');
    expect(formatChapterTime('12:00', 'en-US')).toMatch(/^12:00\s?PM$/);
    expect(formatChapterTime('09:05', 'en-US')).toMatch(/^9:05\s?AM$/);
    expect(formatChapterTime('21:30', 'de')).toBe('21:30');
  });

  it('ignores anything that is not HH:MM', () => {
    expect(formatChapterTime(null, 'de')).toBeNull();
    expect(formatChapterTime('noon', 'de')).toBeNull();
  });
});

describe('GalleryStoryLayout chapter markers', () => {
  const photos = [photo(1, 7, 'Trauung'), photo(2, 7, 'Trauung'), photo(3, 8, 'Party')];
  const categories: PhotoCategory[] = [
    { id: 7, slug: 'ceremony', name: 'Trauung', is_global: false, hero_photo_id: 2, chapter: full },
    // Guest uploads: the server sends no chapter.
    { id: 8, slug: 'party', name: 'Party', is_global: false },
  ];
  const props = {
    photos,
    slug: 'x',
    eventName: 'Sarah & Tom',
    onPhotoClick: () => {},
    onDownload: () => {},
    selectedPhotos: new Set<number>(),
    isSelectionMode: false,
    allowDownloads: true,
    categories,
  } as never;

  it('keeps the plain scene titles while markers are off', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(container.querySelector('.story-chapter')).toBeNull();
    expect([...container.querySelectorAll('.story-scene-title')].map((el) => el.textContent))
      .toEqual(['Trauung', 'Party']);
  });

  it('shows the marker for a category that has one, the plain title elsewhere', () => {
    const { container } = render(<GalleryStoryLayout {...props} chapterMarkerStyle="hero" />);
    const markers = container.querySelectorAll('.story-chapter');
    expect(markers).toHaveLength(1);
    expect((markers[0] as HTMLElement).dataset.chapterStyle).toBe('hero');
    expect(markers[0].querySelector('h2')?.id).toBe('chapter-ceremony');
    expect([...container.querySelectorAll('.story-scene-title')].map((el) => el.textContent)).toEqual(['Party']);
  });
});
