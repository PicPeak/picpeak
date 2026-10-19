/**
 * The viewer's tile size (issue 1733, E4) is one browser-wide choice that
 * every tile layout applies, so a gallery with sidebar controls has to offer
 * the switch too; otherwise a choice made elsewhere sticks with no way back.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GallerySidebar } from '../GallerySidebar';
import { GRID_DENSITY_STORAGE_KEY, resetGridDensityForTests } from '../gridDensity';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' }
    })
  };
});

const renderSidebar = (galleryLayout?: string) => render(
  <GallerySidebar
    isOpen
    onClose={() => {}}
    categories={[]}
    selectedCategoryId={null}
    onCategoryChange={() => {}}
    searchTerm=""
    onSearchChange={() => {}}
    sortBy="date"
    onSortChange={() => {}}
    isSelectionMode={false}
    onToggleSelectionMode={() => {}}
    selectedCount={0}
    onDownloadAll={() => {}}
    onDownloadSelected={() => {}}
    isDownloading={false}
    totalPhotos={0}
    galleryLayout={galleryLayout}
  />
);

beforeEach(() => {
  window.localStorage.clear();
  resetGridDensityForTests();
});

describe('GallerySidebar tile size (issue 1733, E4)', () => {
  it('offers the switch and lets a stored choice go back to Standard', () => {
    window.localStorage.setItem(GRID_DENSITY_STORAGE_KEY, 'compact');
    renderSidebar('masonry');

    expect(screen.getByRole('group', { name: 'Tile size' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'gallery.density.compact' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'gallery.density.default' }));
    expect(screen.getByRole('button', { name: 'gallery.density.default' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(GRID_DENSITY_STORAGE_KEY)).toBeNull();
  });

  it('has no switch for the carousel', () => {
    renderSidebar('carousel');
    expect(screen.queryByRole('group', { name: 'Tile size' })).not.toBeInTheDocument();
  });
});
