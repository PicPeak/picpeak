/**
 * The Masonry mode picker shows the mode the gallery renders (masonryModeOf):
 * a stored 'justified' as Rows, an unknown value as Columns with the column
 * settings, never a picker with nothing selected.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { GalleryLayoutCard } from '../GalleryLayoutCard';
import type { ThemeConfig } from '../../../../types/theme.types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const renderCard = (theme: ThemeConfig) => render(
  <GalleryLayoutCard
    localTheme={theme}
    handleChange={vi.fn()}
    updateGallerySettings={vi.fn()}
    isBetaLayout={false}
    isThumbnailTooSmall={false}
    thumbnailWidth={0}
    thumbnailHeight={0}
    minRecommendedThumbnailSize={0}
  />
);

const checkedMode = () => within(screen.getByRole('radiogroup', { name: 'Layout Mode' })).getAllByRole('radio')
  .filter((radio) => radio.getAttribute('aria-checked') === 'true')
  .map((radio) => radio.textContent);

describe('GalleryLayoutCard — Masonry mode', () => {
  it('shows an unknown stored mode as Columns, with the thumbnail scale', () => {
    renderCard({ galleryLayout: 'masonry', gallerySettings: { masonryMode: 'grid' as never } });
    expect(checkedMode()).toEqual([expect.stringContaining('branding.masonryModeNames.columns')]);
    expect(screen.getByText('Thumbnail Scale')).toBeTruthy();
  });

  it('shows a stored justified as Rows', () => {
    renderCard({ galleryLayout: 'masonry', gallerySettings: { masonryMode: 'justified' } });
    expect(checkedMode()).toEqual([expect.stringContaining('branding.masonryModeNames.rows')]);
  });
});
