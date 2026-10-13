/**
 * Timeline reads `uploaded_at` one way for the day heading, the order and
 * the time chip (issue 1815).
 *
 * On a SQLite install `photos.uploaded_at` is the database default, a
 * zone-less 'YYYY-MM-DD HH:MM:SS' in UTC. The time chip goes through
 * useLocalizedDate, which reads that shape as UTC; the grouping, the heading
 * and the sort used `parseISO` / `new Date`, which read it as local time. A
 * photo uploaded at 00:30 UTC then showed "20:30" under the following day's
 * heading in New York.
 *
 * The assertions compare against the same instants written with a `Z`, so
 * they hold in whatever zone the test machine runs; the suite is run under
 * TZ=America/New_York and TZ=Europe/Berlin, where the two readings differ.
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

const photo = (id: number, uploaded_at: string): Photo => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at,
  width: 4000,
  height: 3000,
} as Photo);

/** What the visitor sees: each day heading with its tiles' time chips, in order. */
const timeline = (photos: Photo[]) => {
  const { container, unmount } = render(
    <TimelineGalleryLayout
      {...({
        photos,
        slug: 'x',
        onPhotoClick: () => {},
        onDownload: () => {},
        selectedPhotos: new Set<number>(),
        isSelectionMode: false,
        allowDownloads: true,
      } as never)}
    />,
  );
  const groups = Array.from(container.querySelectorAll('h3')).map((heading) => ({
    heading: heading.textContent,
    chips: Array.from(heading.parentElement!.parentElement!.querySelectorAll('.photo-card'))
      .map((card) => card.textContent?.match(/\d{2}:\d{2}/)?.[0]),
  }));
  unmount();
  return groups;
};

describe('TimelineGalleryLayout with zone-less SQLite timestamps', () => {
  it('files a photo under the day its time chip belongs to', () => {
    // 00:30 UTC is the previous day west of UTC, 23:30 UTC the next day east
    // of it, so one of the two crosses midnight in every zone but UTC.
    const naive = timeline([photo(1, '2026-10-05 00:30:00'), photo(2, '2026-10-05 23:30:00')]);
    const zoned = timeline([photo(1, '2026-10-05T00:30:00Z'), photo(2, '2026-10-05T23:30:00Z')]);

    expect(naive).toEqual(zoned);
    expect(naive.flatMap((group) => group.chips)).toHaveLength(2);
    expect(naive.flatMap((group) => group.chips)).not.toContain(undefined);
    if (new Date('2026-10-05T12:00:00Z').getTimezoneOffset() !== 0) {
      expect(naive).toHaveLength(2);
    }
  });

  it('orders a zone-less row against one that states its zone by the instant', () => {
    // The second photo is half an hour newer and has to come first; read as
    // local time west of UTC, the zone-less one would be hours ahead of it.
    const naive = timeline([photo(1, '2026-10-05 12:00:00'), photo(2, '2026-10-05T12:30:00.000Z')]);
    const zoned = timeline([photo(1, '2026-10-05T12:00:00Z'), photo(2, '2026-10-05T12:30:00.000Z')]);

    expect(naive).toEqual(zoned);
    expect(naive).toHaveLength(1);
    expect(naive[0].chips[0]).toBe(zoned[0].chips[0]);
  });
});
