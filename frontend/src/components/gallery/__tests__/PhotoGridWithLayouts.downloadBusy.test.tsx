/**
 * Issue 2043: a single-photo download is fetched as a blob before the browser
 * shows anything, which on mobile takes seconds. The tile's download button
 * shows that it is busy meanwhile, and a repeated tap starts nothing: every
 * tap used to be another request and another saved file.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Photo } from '../../../types';

const svc = vi.hoisted(() => ({ downloadPhoto: vi.fn(), trackDownload: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { galleryLayout: 'grid' } }) }));
vi.mock('../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ allows: () => true, canDownload: () => true, remaining: null }),
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { downloadPhoto: svc.downloadPhoto } }));
// The real download hook reads the service through the barrel.
vi.mock('../../../services', () => ({ galleryService: { downloadPhoto: svc.downloadPhoto } }));
vi.mock('../../../services/analytics.service', () => ({ analyticsService: { trackDownload: svc.trackDownload } }));
vi.mock('../../common', () => ({
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => <button {...rest}>{children}</button>,
  AuthenticatedImage: ({ alt }: { alt?: string }) => <img alt={alt} />,
}));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../DownloadResolutionModal', () => ({ DownloadResolutionModal: () => null }));
vi.mock('../HeroHeader', () => ({ HeroHeader: () => null }));
vi.mock('../PhotoLightbox', () => ({ PhotoLightbox: () => null }));
// The real tile, inside a stand-in layout.
vi.mock('../layouts', async () => {
  const { PhotoCard } = await import('../PhotoCard');
  return {
    GridGalleryLayout: ({ photos, onDownload }: {
      photos: Photo[]; onDownload: (photo: Photo, e: React.MouseEvent) => void;
    }) => (
      <div>
        {photos.map((photo) => (
          <PhotoCard
            key={photo.id}
            photo={photo}
            isSelected={false}
            isSelectionMode={false}
            onClick={() => {}}
            onDownload={(e) => onDownload(photo, e)}
            onToggleSelect={() => {}}
            className=""
            overlayBaseClassName=""
            imageProps={{ src: `/t/${photo.id}`, alt: photo.filename }}
            allowDownloads
          />
        ))}
      </div>
    ),
  };
});

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let nextId = 100;
function renderGrid() {
  // A fresh photo per test: the busy set is shared by the whole page.
  const photo = { id: nextId++, filename: 'IMG_0001.jpg' } as Photo;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PhotoGridWithLayouts photos={[photo]} slug="g" />
    </QueryClientProvider>,
  );
  return photo;
}

const downloadButton = () => screen.getByRole('button', { name: /Download photo|Preparing your download/ });

describe('Single-photo download button while the download is prepared (issue 2043)', () => {
  beforeEach(() => {
    svc.downloadPhoto.mockReset();
    svc.trackDownload.mockReset();
  });

  it('shows a busy spinner and ignores repeated taps until the download is handed over', async () => {
    const pending = deferred();
    svc.downloadPhoto.mockReturnValue(pending.promise);
    const photo = renderGrid();

    const button = downloadButton();
    expect(button).not.toHaveAttribute('aria-busy');
    fireEvent.click(button);

    await waitFor(() => expect(downloadButton()).toHaveAttribute('aria-busy', 'true'));
    expect(downloadButton()).toHaveAccessibleName('Preparing your download…');
    expect(downloadButton().querySelector('.animate-spin')).not.toBeNull();

    fireEvent.click(downloadButton());
    fireEvent.click(downloadButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.downloadPhoto).toHaveBeenCalledTimes(1);
    expect(svc.downloadPhoto).toHaveBeenCalledWith('g', photo.id, 'IMG_0001.jpg', expect.any(Function), undefined);
    expect(svc.trackDownload).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => expect(downloadButton()).not.toHaveAttribute('aria-busy'));
    expect(downloadButton()).toHaveAccessibleName('Download photo');

    // Handed over: the next tap is a new download again.
    svc.downloadPhoto.mockResolvedValue(undefined);
    fireEvent.click(downloadButton());
    await waitFor(() => expect(svc.downloadPhoto).toHaveBeenCalledTimes(2));
  });

  it('ignores a second tap in the same moment, before the request has started', async () => {
    svc.downloadPhoto.mockReturnValue(new Promise(() => {}));
    renderGrid();
    const button = downloadButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(svc.downloadPhoto).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.downloadPhoto).toHaveBeenCalledTimes(1);
  });

  it('clears the busy state when the download fails, so it can be tried again', async () => {
    const pending = deferred();
    svc.downloadPhoto.mockReturnValue(pending.promise);
    renderGrid();

    fireEvent.click(downloadButton());
    await waitFor(() => expect(downloadButton()).toHaveAttribute('aria-busy', 'true'));
    pending.reject(new Error('network'));
    await waitFor(() => expect(downloadButton()).not.toHaveAttribute('aria-busy'));

    svc.downloadPhoto.mockResolvedValue(undefined);
    fireEvent.click(downloadButton());
    await waitFor(() => expect(svc.downloadPhoto).toHaveBeenCalledTimes(2));
  });
});
