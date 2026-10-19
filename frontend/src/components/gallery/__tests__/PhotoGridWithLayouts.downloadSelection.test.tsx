/**
 * Selection download through a layout's own control (Story, Premium), at the
 * download limit (issue 1560). The classic layouts' toolbar moved into the
 * gallery toolbar (issue 1733, E8); this path is what the layouts call.
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
vi.mock('../DownloadResolutionModal', () => ({
  DownloadResolutionModal: ({ onClose, onDownloaded }: { onClose: () => void; onDownloaded?: () => void }) => (
    <>
      <button data-testid="picker-close" onClick={onClose} />
      <button data-testid="picker-downloaded" onClick={() => { onDownloaded?.(); onClose(); }} />
    </>
  ),
}));
vi.mock('../BulkRating', () => ({ BulkRating: () => null }));
vi.mock('../HeroHeader', () => ({ HeroHeader: () => null }));
vi.mock('../PhotoLightbox', () => ({ PhotoLightbox: () => null }));
// Stands in for a layout's own Download All, which opens the picker by ids,
// and its Download selected.
vi.mock('../layouts', () => ({
  GridGalleryLayout: ({ onPickResolution, onDownloadSelected }: { onPickResolution: (ids: number[]) => void; onDownloadSelected: () => void }) => (
    <>
      <button data-testid="layout-download-all" onClick={() => onPickResolution([10, 12])} />
      <button data-testid="layout-download-selected" onClick={() => onDownloadSelected()} />
    </>
  ),
}));

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
const downloadButton = () => screen.getByTestId('layout-download-selected');

beforeEach(() => {
  quota.remaining = 1;
  mocks.downloadSelectedPhotos.mockReset();
  mocks.showDownloadLimitReached.mockReset();
});

describe('PhotoGridWithLayouts — selection download at the download limit', () => {
  it('prices the whole selection, photos the search hides included', () => {
    const onSelectionChange = vi.fn();
    mount(onSelectionChange, vi.fn());
    fireEvent.click(downloadButton());
    expect(mocks.showDownloadLimitReached).toHaveBeenCalledWith({ remaining: 1 });
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

  it('keeps the selection when the size picker closes without a download', async () => {
    quota.remaining = 2;
    const onSelectionChange = vi.fn();
    const onToggleSelectionMode = vi.fn();
    render(
      <PhotoGridWithLayouts
        photos={visible}
        slug="g"
        isSelectionMode
        selectedPhotos={new Set([10, 11])}
        onSelectionChange={onSelectionChange}
        onToggleSelectionMode={onToggleSelectionMode}
        photosForIds={photosForIds}
        downloadChoices={[{ id: 'original' }, { id: '1920x1080' }] as never}
      />
    );
    onSelectionChange.mockClear();
    fireEvent.click(downloadButton());
    // Cancelled, or closed on a download-limit refusal / failed build.
    fireEvent.click(await screen.findByTestId('picker-close'));
    expect(screen.queryByTestId('picker-close')).toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onToggleSelectionMode).not.toHaveBeenCalled();
  });

  it('clears the selection and leaves selection mode once the size picker delivered', async () => {
    quota.remaining = 2;
    const onSelectionChange = vi.fn();
    const onToggleSelectionMode = vi.fn();
    render(
      <PhotoGridWithLayouts
        photos={visible}
        slug="g"
        isSelectionMode
        selectedPhotos={new Set([10, 11])}
        onSelectionChange={onSelectionChange}
        onToggleSelectionMode={onToggleSelectionMode}
        photosForIds={photosForIds}
        downloadChoices={[{ id: 'original' }, { id: '1920x1080' }] as never}
      />
    );
    onSelectionChange.mockClear();
    fireEvent.click(downloadButton());
    fireEvent.click(await screen.findByTestId('picker-downloaded'));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
    expect(onToggleSelectionMode).toHaveBeenCalledTimes(1);
  });

  it('closing a Download All picker opened outside selection mode leaves the mode off', () => {
    const onToggleSelectionMode = vi.fn();
    render(
      <PhotoGridWithLayouts
        photos={visible}
        slug="g"
        isSelectionMode={false}
        selectedPhotos={new Set()}
        onSelectionChange={vi.fn()}
        onToggleSelectionMode={onToggleSelectionMode}
        downloadChoices={[{ id: 'original' }, { id: '1920x1080' }] as never}
      />
    );
    fireEvent.click(screen.getByTestId('layout-download-all'));
    fireEvent.click(screen.getByTestId('picker-close'));
    expect(onToggleSelectionMode).not.toHaveBeenCalled();
  });
});
