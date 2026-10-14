/**
 * Selection download in the grid toolbar, at the download limit (issue 1560).
 * A search hides photos without unselecting them and the request sends the
 * whole selection, so the pre-check has to price the whole selection too;
 * and a refusal from the server keeps the selection for the guest to trim.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { Photo } from '../../../types';

const quota = vi.hoisted(() => ({ remaining: 1 }));
const mocks = vi.hoisted(() => ({
  downloadSelectedPhotos: vi.fn(),
  showDownloadLimitReached: vi.fn(),
  limitError: new Error('download limit reached'),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { galleryLayout: 'grid' } }) }));
vi.mock('../../../contexts/DownloadQuotaContext', () => {
  const cost = (list: Array<{ download_granted?: boolean }>) => list.filter((p) => !p.download_granted).length;
  return {
    useDownloadQuota: () => ({
      limited: true,
      remaining: quota.remaining,
      allows: (list: Array<{ download_granted?: boolean }>) => cost(list) <= quota.remaining,
      canDownload: () => true,
      costOf: cost,
    }),
  };
});
vi.mock('../../../utils/downloadLimit', () => ({
  isDownloadLimitError: (error: unknown) => error === mocks.limitError,
  showDownloadLimitReached: mocks.showDownloadLimitReached,
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: mocks.downloadSelectedPhotos },
}));
vi.mock('../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../common', () => ({ Button: ({ children, leftIcon: _icon, variant: _v, size: _s, ...rest }: any) => <button {...rest}>{children}</button> }));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../DownloadResolutionModal', () => ({ DownloadResolutionModal: () => null }));
vi.mock('../BulkRating', () => ({ BulkRating: () => null }));
vi.mock('../HeroHeader', () => ({ HeroHeader: () => null }));
vi.mock('../PhotoLightbox', () => ({ PhotoLightbox: () => null }));
vi.mock('../layouts', () => ({ GridGalleryLayout: () => null }));

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

// Photo 11 is selected but hidden by a search; 10 and 12 are on screen.
const visible = [10, 12].map((id) => ({ id, filename: `${id}.jpg` } as Photo));
const everyPhoto = new Map([10, 11, 12].map((id) => [id, { id, download_granted: false }]));
const photosForIds = (ids: number[]) => ids.map((id) => everyPhoto.get(id) ?? { id });

const mount = (onSelectionChange: ReturnType<typeof vi.fn>, onToggleSelectionMode: ReturnType<typeof vi.fn>) => {
  render(
    <PhotoGridWithLayouts
      photos={visible}
      slug="g"
      isSelectionMode
      selectedPhotos={new Set([10, 11])}
      onSelectionChange={onSelectionChange}
      onToggleSelectionMode={onToggleSelectionMode}
      photosForIds={photosForIds}
    />
  );
  // The grid clears the selection on a category change, mount included.
  onSelectionChange.mockClear();
};
const downloadButton = () => screen.getByText('gallery.downloadSelected').closest('button') as HTMLButtonElement;

beforeEach(() => {
  quota.remaining = 1;
  mocks.downloadSelectedPhotos.mockReset();
  mocks.showDownloadLimitReached.mockReset();
});

describe('PhotoGridWithLayouts — selection download at the download limit', () => {
  it('prices the whole selection, photos the search hides included', () => {
    const onSelectionChange = vi.fn();
    mount(onSelectionChange, vi.fn());
    expect(downloadButton()).toBeDisabled();
    fireEvent.click(downloadButton());
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('keeps the selection when the server refuses at the limit', async () => {
    quota.remaining = 2;
    mocks.downloadSelectedPhotos.mockRejectedValue(mocks.limitError);
    const onSelectionChange = vi.fn();
    const onToggleSelectionMode = vi.fn();
    mount(onSelectionChange, onToggleSelectionMode);
    fireEvent.click(downloadButton());
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalledWith('g', [10, 11]));
    await Promise.resolve();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onToggleSelectionMode).not.toHaveBeenCalled();
  });

  it('clears the selection and leaves selection mode after a download', async () => {
    quota.remaining = 2;
    mocks.downloadSelectedPhotos.mockResolvedValue(undefined);
    const onSelectionChange = vi.fn();
    const onToggleSelectionMode = vi.fn();
    mount(onSelectionChange, onToggleSelectionMode);
    fireEvent.click(downloadButton());
    await waitFor(() => expect(onToggleSelectionMode).toHaveBeenCalledTimes(1));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
  });
});
