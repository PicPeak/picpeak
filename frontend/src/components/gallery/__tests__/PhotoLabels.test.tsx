/**
 * Neutral photo labels (issue 1733, E6): with the gallery switch on, the
 * shared tile, the lightbox and the selection tray name a photo "Photo 2 of 3"
 * by its place in the guest's list instead of by its filename. Off, nothing
 * changes.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Photo } from '../../../types';

// Interpolates like i18next, so the label's numbers are visible to the test.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, a?: unknown, b?: unknown) => {
      const opts = (typeof a === 'object' ? a : b) as Record<string, unknown> | undefined;
      const template = typeof a === 'string' ? a : (opts?.defaultValue as string | undefined) ?? key;
      return template.replace(/{{(\w+)}}/g, (_, name: string) => String(opts?.[name] ?? ''));
    },
  }),
}));
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: () => {}, inView: true }) }));

import { PhotoCard } from '../PhotoCard';
import { PhotoLightbox } from '../PhotoLightbox';
import { GallerySidebarSelectionTray } from '../GallerySidebarSelectionTray';
import { PhotoLabelsProvider } from '../PhotoLabels';
import { DownloadQuotaProvider } from '../../../contexts/DownloadQuotaContext';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photo = (id: number): Photo => ({
  id,
  filename: `stored-${id}.jpg`,
  original_filename: `IMG_47${id}.jpg`,
  url: `/p/${id}`,
  thumbnail_url: `/t/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
} as Photo);
const photos = [photo(1), photo(2), photo(3)];

const wrap = (ui: React.ReactNode, neutral?: boolean) => (
  <QueryClientProvider client={new QueryClient()}>
    <DownloadQuotaProvider slug="g" event={{} as never}>
      {neutral === undefined ? ui : <PhotoLabelsProvider neutral={neutral} photos={photos}>{ui}</PhotoLabelsProvider>}
    </DownloadQuotaProvider>
  </QueryClientProvider>
);

const card = (p: Photo) => (
  <PhotoCard
    photo={p}
    isSelected={false}
    isSelectionMode
    onClick={() => {}}
    onDownload={() => {}}
    onToggleSelect={() => {}}
    imageProps={{ src: p.thumbnail_url!, alt: p.filename }}
    overlayBaseClassName="absolute inset-0"
  />
);

describe('neutral photo labels on the shared tile', () => {
  it('keeps the filename without the gallery context and with the switch off', () => {
    const { unmount } = render(wrap(card(photos[1])));
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'stored-2.jpg');
    expect(screen.getByRole('checkbox')).toHaveAccessibleName('Select stored-2.jpg');
    unmount();
    render(wrap(card(photos[1]), false));
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'stored-2.jpg');
  });

  it('numbers the photo by its place in the list with the switch on', () => {
    render(wrap(card(photos[1]), true));
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'Photo 2 of 3');
    expect(screen.getByRole('checkbox')).toHaveAccessibleName('Select Photo 2 of 3');
    expect(document.body.textContent).not.toContain('stored-2');
  });

  it('a nested provider numbers against its own list and inherits the switch', () => {
    render(wrap(
      <PhotoLabelsProvider photos={[photos[2], photos[1]]}>{card(photos[1])}</PhotoLabelsProvider>,
      true,
    ));
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'Photo 2 of 2');
  });
});

describe('neutral photo labels in the lightbox', () => {
  const lightbox = <PhotoLightbox photos={photos} initialIndex={0} onClose={vi.fn()} slug="g" showOriginalFilename />;

  it('shows the counter and the original filename with the switch off', () => {
    render(wrap(lightbox, false));
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    expect(screen.getByText('IMG_471.jpg')).toBeInTheDocument();
  });

  it('shows "Photo 1 of 3" instead, and no filename anywhere, with the switch on', () => {
    render(wrap(lightbox, true));
    expect(screen.getByText('Photo 1 of 3')).toBeInTheDocument();
    expect(screen.queryByText('1 / 3')).toBeNull();
    expect(document.body.textContent).not.toMatch(/IMG_47|stored-/);
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('alt')))
      .toEqual(expect.arrayContaining(['Photo 1 of 3', 'Photo 2 of 3']));
    expect(document.body.innerHTML).not.toMatch(/alt="(IMG_47|stored-)/);

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByText('Photo 2 of 3')).toBeInTheDocument();
  });
});

describe('neutral photo labels in the selection tray', () => {
  it('lists the selection by number with the switch on', () => {
    render(wrap(<GallerySidebarSelectionTray photos={[photos[2]]} onRemove={() => {}} />, true));
    expect(screen.getByText('Photo 3 of 3')).toBeInTheDocument();
    expect(screen.queryByText('IMG_473.jpg')).toBeNull();
  });

  it('keeps selected photos a filter hides apart by their place in the tray', () => {
    const hidden = [photo(7), photo(8)];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PhotoLabelsProvider neutral photos={photos}>
          <GallerySidebarSelectionTray photos={[photos[0], ...hidden]} onRemove={() => {}} />
        </PhotoLabelsProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Photo 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Selected photo 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Selected photo 3 of 3')).toBeInTheDocument();
    expect(screen.queryByText('IMG_477.jpg')).toBeNull();
  });
});
