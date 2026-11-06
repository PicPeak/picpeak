import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';
import { StoryHero } from '../layouts/story/StoryHero';
import type { Photo } from '../../../types';

/**
 * An event date is a bare yyyy-MM-dd. `new Date('2026-11-01')` is UTC
 * midnight, which west of UTC is still the evening before, so a gallery
 * viewed in the US showed the day before the event. Both hero headers must
 * print the calendar day as stored, whatever the viewer's time zone.
 */

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', async () => ({
  ...await vi.importActual('../../common'),
  AuthenticatedImage: ({ alt }: { alt?: string }) => <img alt={alt} />,
  PoweredBy: () => null,
}));
vi.mock('react-photo-album', () => ({ MasonryPhotoAlbum: () => null }));

const photos = [{
  id: 1, filename: 'photo-1.jpg', url: '/api/gallery/demo/photo/1',
  thumbnail_url: '/api/gallery/demo/thumbnail/1', width: 6000, height: 4000,
  type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
}] as Photo[];

const originalTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Denver'; });
afterAll(() => { process.env.TZ = originalTz; });
afterEach(cleanup);

describe('gallery hero date in a time zone west of UTC', () => {
  it('Gallery Premium shows the event day, not the day before', () => {
    render(<GalleryPremiumLayout
      photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      allowDownloads={false} eventName="Demo Gallery" eventDate="2026-11-01"
    />);
    expect(screen.getByText('November 01, 2026')).toBeTruthy();
    expect(screen.queryByText('October 31, 2026')).toBeNull();
  });

  it('Gallery Story shows the event day, not the day before', () => {
    render(<StoryHero title="Demo Gallery" date="2026-11-01" stats="18 photos" slug="demo" />);
    expect(screen.getByText('November 1, 2026')).toBeTruthy();
    expect(screen.queryByText('October 31, 2026')).toBeNull();
  });
});
