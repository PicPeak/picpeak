/**
 * Videos first in the Timeline (issue 2263). The timeline orders by upload
 * date whatever the gallery's sort; with videos first the videos lead inside
 * each date group, and the groups stay newest first.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

import { TimelineGalleryLayout } from '../TimelineGalleryLayout';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key, i18n: { language: 'en' } }),
}));
vi.mock('../../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_date_format: 'YYYY-MM-DD', general_time_format: '24h' } }),
}));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => {}, inView: true }),
}));
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  PoweredBy: () => null,
}));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { timelineGrouping: 'day' } } }),
}));

const photo = (id: number, uploaded_at: string, video = false): Photo => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at,
  width: 4000,
  height: 3000,
  ...(video ? { media_type: 'video', mime_type: 'video/mp4' } : {}),
} as Photo);

/** Each date group's tile time chips, in order. */
const timeline = (photos: Photo[], videosFirst?: boolean) => {
  const { container, unmount } = render(
    <TimelineGalleryLayout
      {...({
        photos,
        videosFirst,
        slug: 'x',
        onPhotoClick: () => {},
        onDownload: () => {},
        selectedPhotos: new Set<number>(),
        isSelectionMode: false,
        allowDownloads: true,
      } as never)}
    />,
  );
  const groups = Array.from(container.querySelectorAll('h3')).map((heading) =>
    Array.from(heading.parentElement!.parentElement!.querySelectorAll('.photo-card'))
      .map((card) => card.textContent?.match(/\d{2}:\d{2}/)?.[0]));
  unmount();
  return groups;
};

const at = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('TimelineGalleryLayout with videos first', () => {
  const photos = [
    photo(1, '2026-10-05T12:10:00Z'),
    photo(2, '2026-10-05T12:20:00Z', true),
    photo(3, '2026-10-05T12:30:00Z'),
    photo(4, '2026-10-03T12:40:00Z', true),
    photo(5, '2026-10-03T12:50:00Z'),
  ];

  it('keeps the plain upload order when off', () => {
    expect(timeline(photos)).toEqual([
      [at('2026-10-05T12:30:00Z'), at('2026-10-05T12:20:00Z'), at('2026-10-05T12:10:00Z')],
      [at('2026-10-03T12:50:00Z'), at('2026-10-03T12:40:00Z')],
    ]);
  });

  it('puts the videos first inside each day', () => {
    expect(timeline(photos, true)).toEqual([
      [at('2026-10-05T12:20:00Z'), at('2026-10-05T12:30:00Z'), at('2026-10-05T12:10:00Z')],
      [at('2026-10-03T12:40:00Z'), at('2026-10-03T12:50:00Z')],
    ]);
  });
});
