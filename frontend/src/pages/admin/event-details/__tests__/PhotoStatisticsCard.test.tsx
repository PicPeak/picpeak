/**
 * The statistics card on an event's overview (issue 1430).
 *
 * An event that holds videos reported them as photos: "Total Photos: 40" for
 * forty clips. It now counts by type and says "media"; an event with photos
 * only reads exactly as it did.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

import { PhotoStatisticsCard } from '../PhotoStatisticsCard';
import type { Event } from '../../../../types';

const renderCard = (over: Partial<Event>) => render(
  <PhotoStatisticsCard
    event={{ id: 1, event_name: 'E', photo_count: 0, ...over } as Event}
    categories={[]}
    setActiveTab={vi.fn()}
  />
);

/** The value shown on the row carrying this label. */
const valueOf = (label: string) => screen.getByText(label).parentElement!.lastElementChild!.textContent;

describe('PhotoStatisticsCard', () => {
  it('keeps the photo wording for an event without videos', () => {
    renderCard({ photo_count: 12, video_count: 0, video_duration: 0 });

    expect(screen.getByText('events.photoStatistics')).toBeInTheDocument();
    expect(valueOf('events.totalPhotos')).toBe('12');
    expect(screen.getByRole('button', { name: 'events.managePhotos' })).toBeInTheDocument();
    expect(screen.queryByText('Videos')).not.toBeInTheDocument();
    expect(screen.queryByText('Video runtime')).not.toBeInTheDocument();
  });

  it('counts photos and videos apart, with the total runtime, once there are videos', () => {
    renderCard({ photo_count: 143, video_count: 6, video_duration: 754 });

    expect(screen.getByText('Media Statistics')).toBeInTheDocument();
    expect(valueOf('events.photos')).toBe('137');
    expect(valueOf('Videos')).toBe('6');
    expect(valueOf('Video runtime')).toBe('12:34');
    expect(screen.getByRole('button', { name: 'Manage Media' })).toBeInTheDocument();
    expect(screen.queryByText('events.totalPhotos')).not.toBeInTheDocument();
  });

  it('reports a video-only event as zero photos, not as forty', () => {
    renderCard({ photo_count: 40, video_count: 40, video_duration: 3723 });

    expect(valueOf('events.photos')).toBe('0');
    expect(valueOf('Videos')).toBe('40');
    expect(valueOf('Video runtime')).toBe('1:02:03');
  });
});
