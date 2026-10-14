/**
 * Gallery Premium's nav: Download All downloads (it used to toggle-select the
 * photos one by one against a stale set, leaving only the last one selected
 * and downloading nothing), Select all compares the selection by id, and the
 * selection download prices the whole selection at the download limit.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Photo } from '../../../types';

const quota = vi.hoisted(() => ({ remaining: 10 }));
const mocks = vi.hoisted(() => ({
  downloadSelectedPhotos: vi.fn(),
  showDownloadLimitReached: vi.fn(),
}));

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../contexts/DownloadQuotaContext', () => {
  const cost = (list: Array<{ download_granted?: boolean }>) => list.filter((p) => !p.download_granted).length;
  return {
    useDownloadQuota: () => ({
      limited: true,
      previewOnly: false,
      remaining: quota.remaining,
      allows: (list: Array<{ download_granted?: boolean }>) => cost(list) <= quota.remaining,
      canDownload: () => true,
      costOf: cost,
    }),
  };
});
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../utils/downloadLimit', () => ({
  isDownloadLimitError: () => false,
  showDownloadLimitReached: mocks.showDownloadLimitReached,
}));
vi.mock('../../../services/gallery.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/gallery.service')>('../../../services/gallery.service');
  return {
    splitIntoArchives: actual.splitIntoArchives,
    galleryService: {
      trackPhotoView: vi.fn(),
      downloadSelectedPhotos: mocks.downloadSelectedPhotos,
      downloadPhotosInParts: actual.galleryService.downloadPhotosInParts,
    },
  };
});
vi.mock('../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
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

// 1 and 2 are Ceremony, 3 and 4 Party.
const photos = [1, 2, 3, 4].map((id) => ({
  id, filename: `photo-${id}.jpg`, category_name: id <= 2 ? 'Ceremony' : 'Party',
  url: `/api/gallery/demo/photo/${id}`, thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  width: 6000, height: 4000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

const downloadAll = () => screen.getByTitle('common.downloadAll');

beforeEach(() => {
  quota.remaining = 10;
  mocks.downloadSelectedPhotos.mockReset().mockResolvedValue(undefined);
  mocks.showDownloadLimitReached.mockReset();
});
afterEach(() => cleanup());

describe('Gallery Premium — Download All', () => {
  it('runs the whole-gallery download and selects nothing', () => {
    const onDownloadEverything = vi.fn();
    const onPhotoSelect = vi.fn();
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      onPhotoSelect={onPhotoSelect} onDownloadEverything={onDownloadEverything} />);
    fireEvent.click(downloadAll());
    expect(onDownloadEverything).toHaveBeenCalledTimes(1);
    expect(onPhotoSelect).not.toHaveBeenCalled();
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
  });

  it('downloads the photos in scope when there is no whole-gallery path', async () => {
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} />);
    fireEvent.click(downloadAll());
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalledWith('demo', [1, 2, 3, 4]));
  });

  it('hands off to the resolution picker when the gallery offers a choice', () => {
    const onPickResolution = vi.fn();
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      downloadChoices={[{ id: 'original' }, { id: '1920x1080' }] as never} onPickResolution={onPickResolution} />);
    fireEvent.click(downloadAll());
    expect(onPickResolution).toHaveBeenCalledWith([1, 2, 3, 4]);
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
  });

  it('leaves out photos in a category that opts out of downloads', async () => {
    const list = photos.map((photo) => ({ ...photo, category_allow_downloads: photo.category_name !== 'Party' }));
    render(<GalleryPremiumLayout photos={list} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} />);
    fireEvent.click(downloadAll());
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalledWith('demo', [1, 2]));
  });

  it('is absent when nothing in scope can be downloaded and there is no whole-gallery path', () => {
    const list = photos.map((photo) => ({ ...photo, category_allow_downloads: false }));
    render(<GalleryPremiumLayout photos={list} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} />);
    expect(screen.queryByTitle('common.downloadAll')).toBeNull();
  });

  it('is offered on a folder-only root when the whole gallery can be downloaded', () => {
    const onDownloadEverything = vi.fn();
    render(<GalleryPremiumLayout photos={[]} suppressEmptyState slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      onDownloadEverything={onDownloadEverything} />);
    fireEvent.click(downloadAll());
    expect(onDownloadEverything).toHaveBeenCalledTimes(1);
  });

  // The server takes at most 500 ids per archive; past that the fallback used
  // to post every id and get back an archive cut at the first 500.
  const manyPhotos = (count: number) => Array.from({ length: count }, (_, i) => ({
    ...photos[0], id: i + 1, filename: `photo-${i + 1}.jpg`,
  })) as Photo[];
  const idsFrom = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it('downloads more than 500 photos as several zips, none left out', async () => {
    quota.remaining = 5000;
    render(<GalleryPremiumLayout photos={manyPhotos(1201)} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} />);
    fireEvent.click(downloadAll());
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalledTimes(3));
    expect(mocks.downloadSelectedPhotos).toHaveBeenNthCalledWith(1, 'demo', idsFrom(1, 500), { index: 1, total: 3 });
    expect(mocks.downloadSelectedPhotos).toHaveBeenNthCalledWith(2, 'demo', idsFrom(501, 1000), { index: 2, total: 3 });
    expect(mocks.downloadSelectedPhotos).toHaveBeenNthCalledWith(3, 'demo', idsFrom(1001, 1201), { index: 3, total: 3 });
  });

  it('stops at the first part that fails', async () => {
    quota.remaining = 5000;
    mocks.downloadSelectedPhotos.mockReset().mockRejectedValueOnce(new Error('network'));
    render(<GalleryPremiumLayout photos={manyPhotos(1201)} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} />);
    fireEvent.click(downloadAll());
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.downloadSelectedPhotos).toHaveBeenCalledTimes(1);
  });

  it('skips the resolution picker past 500 photos, whose single archive would be cut short', async () => {
    quota.remaining = 5000;
    const onPickResolution = vi.fn();
    render(<GalleryPremiumLayout photos={manyPhotos(501)} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      downloadChoices={[{ id: 'original' }, { id: '1920x1080' }] as never} onPickResolution={onPickResolution} />);
    fireEvent.click(downloadAll());
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalledTimes(2));
    expect(onPickResolution).not.toHaveBeenCalled();
  });

  it('refuses at the download limit before asking the server', () => {
    quota.remaining = 3;
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} />);
    fireEvent.click(downloadAll());
    expect(mocks.showDownloadLimitReached).toHaveBeenCalledWith({ remaining: 3 });
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
  });
});

describe('Gallery Premium — selection controls', () => {
  it('offers Select all when a same-sized selection is from another category', () => {
    const onSelectAll = vi.fn();
    const onDeselectAll = vi.fn();
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      isSelectionMode selectedPhotos={new Set([3, 4])} onSelectAll={onSelectAll} onDeselectAll={onDeselectAll} />);
    fireEvent.click(screen.getByText('Ceremony'));
    fireEvent.click(screen.getByText('gallery.selectAll'));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onDeselectAll).not.toHaveBeenCalled();
  });

  it('selects only the photos under the active category chip', () => {
    const onSelectMany = vi.fn();
    const onSelectAll = vi.fn();
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      isSelectionMode selectedPhotos={new Set([1])} onSelectMany={onSelectMany} onSelectAll={onSelectAll} />);
    fireEvent.click(screen.getByText('Ceremony'));
    fireEvent.click(screen.getByText('gallery.selectAll'));
    expect(onSelectMany).toHaveBeenCalledWith([1, 2]);
    expect(onSelectAll).not.toHaveBeenCalled();
  });

  it('clears the selection and leaves selection mode after a selection download', async () => {
    const onDeselectAll = vi.fn();
    const onToggleSelectionMode = vi.fn();
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      isSelectionMode selectedPhotos={new Set([1, 2])} onDeselectAll={onDeselectAll}
      onToggleSelectionMode={onToggleSelectionMode} />);
    fireEvent.click(screen.getByText(/common\.download \(2\)/));
    await waitFor(() => expect(onToggleSelectionMode).toHaveBeenCalledTimes(1));
    expect(mocks.downloadSelectedPhotos).toHaveBeenCalledWith('demo', [1, 2]);
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the selection when a selection download fails', async () => {
    mocks.downloadSelectedPhotos.mockRejectedValue(new Error('network'));
    const onDeselectAll = vi.fn();
    const onToggleSelectionMode = vi.fn();
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      isSelectionMode selectedPhotos={new Set([1, 2])} onDeselectAll={onDeselectAll}
      onToggleSelectionMode={onToggleSelectionMode} />);
    fireEvent.click(screen.getByText(/common\.download \(2\)/));
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalled());
    await Promise.resolve();
    expect(onDeselectAll).not.toHaveBeenCalled();
    expect(onToggleSelectionMode).not.toHaveBeenCalled();
  });

  it('offers Deselect all when every photo on screen is selected', () => {
    const onDeselectAll = vi.fn();
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      isSelectionMode selectedPhotos={new Set([1, 2])} onDeselectAll={onDeselectAll} />);
    fireEvent.click(screen.getByText('Ceremony'));
    fireEvent.click(screen.getByText('gallery.deselectAll'));
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('prices the whole selection, photos a search hides included', () => {
    quota.remaining = 1;
    // Photo 5 is selected but hidden by a search: not in `photos`.
    render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
      isSelectionMode selectedPhotos={new Set([1, 5])} selectionQuotaPhotos={[{ id: 1 }, { id: 5 }]} />);
    fireEvent.click(screen.getByText(/common\.download \(2\)/));
    expect(mocks.showDownloadLimitReached).toHaveBeenCalledWith({ remaining: 1 });
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
  });
});
