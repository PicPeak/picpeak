/**
 * The grid on its own (no gallery state handed in): leaving selection mode
 * through the layout's own control drops the selection, as GalleryView's
 * toggle and the classic PhotoGrid do.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { galleryLayout: 'grid' } }) }));
vi.mock('../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ limited: false, remaining: null, allows: () => true, canDownload: () => true, costOf: () => 0 }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: {} }));
vi.mock('../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../common', () => ({ Button: ({ children, leftIcon: _icon, variant: _v, size: _s, ...rest }: any) => <button {...rest}>{children}</button> }));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../DownloadResolutionModal', () => ({ DownloadResolutionModal: () => null }));
vi.mock('../BulkRating', () => ({ BulkRating: () => null }));
vi.mock('../HeroHeader', () => ({ HeroHeader: () => null }));
vi.mock('../PhotoLightbox', () => ({ PhotoLightbox: () => null }));
// Stands in for a layout with its own selection controls (Story, Premium).
vi.mock('../layouts', () => ({
  GridGalleryLayout: ({ isSelectionMode, selectedPhotos, onToggleSelectionMode, onSelectAll }: {
    isSelectionMode: boolean;
    selectedPhotos: Set<number>;
    onToggleSelectionMode: () => void;
    onSelectAll: () => void;
  }) => (
    <>
      <span data-testid="mode">{isSelectionMode ? 'on' : 'off'}</span>
      <span data-testid="count">{selectedPhotos.size}</span>
      <button data-testid="toggle" onClick={onToggleSelectionMode} />
      <button data-testid="select-all" onClick={onSelectAll} />
    </>
  ),
}));

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

const photos = [1, 2, 3].map((id) => ({ id, filename: `${id}.jpg` } as Photo));

describe('PhotoGridWithLayouts — Cancel selection without gallery state', () => {
  it('Select all, then Cancel selection, leaves nothing selected', () => {
    render(<PhotoGridWithLayouts photos={photos} slug="g" />);
    fireEvent.click(screen.getByTestId('toggle'));
    fireEvent.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('count').textContent).toBe('3');

    fireEvent.click(screen.getByTestId('toggle'));
    expect(screen.getByTestId('mode').textContent).toBe('off');
    expect(screen.getByTestId('count').textContent).toBe('0');

    fireEvent.click(screen.getByTestId('toggle'));
    expect(screen.getByTestId('mode').textContent).toBe('on');
    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});
