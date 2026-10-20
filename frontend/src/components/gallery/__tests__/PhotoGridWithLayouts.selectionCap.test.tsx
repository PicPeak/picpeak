/**
 * A selected download over the server's per-download cap is refused
 * (400 TOO_MANY_PHOTO_IDS) instead of zipping the first 500. The grid keeps
 * the selection and its mode then, so the guest can trim it; any other outcome
 * still clears it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { Photo } from '../../../types';
import { DownloadLimitError, SelectionTooLargeError } from '../../../utils/downloadLimit';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { galleryLayout: 'grid' } }) }));
vi.mock('../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ allows: () => true, canDownload: () => true, remaining: null }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
const service = vi.hoisted(() => ({ downloadSelectedPhotos: vi.fn() }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: service }));
vi.mock('../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../common', () => ({ Button: ({ children, leftIcon: _icon, ...rest }: React.ComponentProps<'button'> & { leftIcon?: unknown }) => <button {...rest}>{children}</button> }));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../DownloadResolutionModal', () => ({ DownloadResolutionModal: () => null }));
vi.mock('../HeroHeader', () => ({ HeroHeader: () => null }));
// A layout's own Select all and Download selected (Story, Premium): the
// classic layouts' toolbar moved into the gallery toolbar (issue 1733, E8).
vi.mock('../layouts', () => ({
  GridGalleryLayout: ({ onSelectMany, onDownloadSelected, isSelectionMode }: {
    onSelectMany: (ids: number[]) => void; onDownloadSelected: () => void; isSelectionMode: boolean;
  }) => (
    <>
      <button onClick={() => onSelectMany([10, 11, 12])}>select all</button>
      <button onClick={() => onDownloadSelected()}>download selected</button>
      {isSelectionMode && <span>selecting</span>}
    </>
  ),
}));

import { toast } from 'react-toastify';
import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

const photos = [10, 11, 12].map((id) => ({ id, filename: `${id}.jpg` } as Photo));

async function selectAllAndDownload() {
  render(<PhotoGridWithLayouts photos={photos} slug="g" />);
  fireEvent.click(screen.getByText('select all'));
  fireEvent.click(screen.getByText('download selected'));
  await waitFor(() => expect(service.downloadSelectedPhotos).toHaveBeenCalledWith('g', [10, 11, 12]));
}

describe('PhotoGridWithLayouts — selection over the download cap', () => {
  beforeEach(() => {
    service.downloadSelectedPhotos.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it('keeps the selection when the server refuses it as too large', async () => {
    service.downloadSelectedPhotos.mockRejectedValue(new SelectionTooLargeError(500));
    await selectAllAndDownload();
    // Still in selection mode, to retry or trim.
    await waitFor(() => expect(screen.getByText('selecting')).toBeTruthy());
    // The wrapper already said why; no generic "download failed" on top.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the selection after a download limit refusal too, to trim it', async () => {
    service.downloadSelectedPhotos.mockRejectedValue(new DownloadLimitError({ remaining: 0 }));
    await selectAllAndDownload();
    await waitFor(() => expect(service.downloadSelectedPhotos).toHaveBeenCalled());
    expect(screen.getByText('selecting')).toBeTruthy();
  });
});
