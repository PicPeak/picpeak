/**
 * Premium's category tabs (issue 2550): the chosen tab is the category, not
 * its name. A language switch re-translates every photo's category_name
 * ("Ceremony" -> "Trauung"); the tab stays chosen and the grid stays filled.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Photo } from '../../../types';

vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: undefined }) }));
vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
const submitFeedback = vi.hoisted(() => vi.fn());
vi.mock('../../../services/feedback.service', async () => ({
  ...await vi.importActual('../../../services/feedback.service'),
  feedbackService: { submitFeedback },
}));
vi.mock('../../common', async () => ({ ...await vi.importActual('../../common'), PoweredBy: () => null }));
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: ({ photos, render: renderer }: any) => <>{photos.map((photo: any, index: number) =>
    <React.Fragment key={photo.key}>{renderer.photo({}, { photo, index, width: 300, height: 200 })}</React.Fragment>
  )}</>,
}));
vi.mock('yet-another-react-lightbox', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';

const photos = (names: Record<number, string>) => [1, 2, 3, 4].map((id) => {
  const categoryId = id <= 2 ? 11 : 12;
  return {
    id, filename: `photo-${id}.jpg`, url: `/p/${id}`, thumbnail_url: `/t/${id}`, width: 6000, height: 4000,
    type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z', category_id: categoryId, category_name: names[categoryId],
  };
}) as Photo[];

const layout = (source: Photo[]) => (
  <GalleryPremiumLayout photos={source} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} allowDownloads={false} />
);

const shownIds = () => screen.queryAllByTestId(/^photo-card-\d+$/)
  .map((card) => Number(card.dataset.testid?.replace('photo-card-', '')))
  .sort();

afterEach(() => cleanup());

describe('Gallery Premium — category tabs across a language switch', () => {
  it('keeps the chosen category when its name is re-translated', () => {
    const { rerender } = render(layout(photos({ 11: 'Ceremony', 12: 'Party' })));
    fireEvent.click(screen.getByRole('button', { name: 'Ceremony' }));
    expect(shownIds()).toEqual([1, 2]);
    rerender(layout(photos({ 11: 'Trauung', 12: 'Feier' })));
    expect(shownIds()).toEqual([1, 2]);
    expect(screen.getByRole('button', { name: 'Trauung' }).className).toContain('active');
  });

  it('still groups two categories that share a name in one tab', () => {
    const shared = photos({ 11: 'Party', 12: 'Party' });
    render(layout(shared));
    expect(screen.getAllByRole('button', { name: 'Party' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Party' }));
    expect(shownIds()).toEqual([1, 2, 3, 4]);
  });
});
