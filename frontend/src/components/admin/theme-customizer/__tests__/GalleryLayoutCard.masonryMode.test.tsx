/**
 * The Masonry mode select shows the mode the gallery renders (masonryModeOf):
 * a stored 'justified' as Rows, with the row settings, and an unknown value
 * as Columns, with the thumbnail scale.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

const modeSelect = () => screen.getByDisplayValue(/Columns \(Pinterest-style\)|Rows \(Custom justified\)|Flickr/) as HTMLSelectElement;

describe('GalleryLayoutCard — Masonry mode', () => {
  it('shows a stored justified as Rows, with the last-row alignment, and no longer offers it', () => {
    renderCard({ galleryLayout: 'masonry', gallerySettings: { masonryMode: 'justified' } });
    expect(modeSelect().value).toBe('rows');
    expect(screen.queryByRole('option', { name: /Google Photos/ })).toBeNull();
    expect(screen.getByText('Last Row Alignment')).toBeTruthy();
  });

  it('shows an unknown stored mode as Columns, with the thumbnail scale', () => {
    renderCard({ galleryLayout: 'masonry', gallerySettings: { masonryMode: 'grid' as never } });
    expect(modeSelect().value).toBe('columns');
    expect(screen.getByText('Thumbnail Scale')).toBeTruthy();
  });
});
