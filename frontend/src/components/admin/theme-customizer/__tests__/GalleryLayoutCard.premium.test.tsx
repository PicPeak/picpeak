/**
 * Gallery Premium's settings in the theme editor (issues 2425, 2429): columns
 * per device and the gap in pixels, clamped as they are typed, and the hero
 * photo's fit, offered for a hero header and for Premium, which always has
 * a hero.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GalleryLayoutCard } from '../GalleryLayoutCard';
import { HeaderStyleCard } from '../HeaderStyleCard';
import type { ThemeConfig } from '../../../../types/theme.types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const renderCard = (theme: ThemeConfig, updateGallerySettings = vi.fn()) => {
  render(
    <GalleryLayoutCard
      localTheme={theme}
      handleChange={vi.fn()}
      updateGallerySettings={updateGallerySettings}
      isBetaLayout={false}
      isThumbnailTooSmall={false}
      thumbnailWidth={0}
      thumbnailHeight={0}
      minRecommendedThumbnailSize={0}
    />
  );
  return updateGallerySettings;
};

describe('GalleryLayoutCard — Premium settings', () => {
  it('shows the original 1, 2, 3 columns and 16 px, and no spacing select Premium ignores', () => {
    renderCard({ galleryLayout: 'gallery-premium' });
    expect(screen.getByLabelText('branding.mobile')).toHaveValue(1);
    expect(screen.getByLabelText('branding.tablet')).toHaveValue(2);
    expect(screen.getByLabelText('branding.desktop')).toHaveValue(3);
    expect(screen.getByLabelText('Gap between photos (px)')).toHaveValue(16);
    expect(screen.queryByText('branding.photoSpacing')).toBeNull();
  });

  it('stores a device\'s columns within its range and keeps the others', () => {
    const update = renderCard({ galleryLayout: 'gallery-premium', gallerySettings: { premiumColumns: { mobile: 1, tablet: 2, desktop: 4 } } });
    fireEvent.change(screen.getByLabelText('branding.mobile'), { target: { value: '2' } });
    expect(update).toHaveBeenLastCalledWith('premiumColumns', { mobile: 2, tablet: 2, desktop: 4 });
    fireEvent.change(screen.getByLabelText('branding.mobile'), { target: { value: '7' } });
    expect(update).toHaveBeenLastCalledWith('premiumColumns', { mobile: 3, tablet: 2, desktop: 4 });
  });

  it('stores the gap in pixels, clamped, and ignores an emptied field', () => {
    const update = renderCard({ galleryLayout: 'gallery-premium' });
    const gap = screen.getByLabelText('Gap between photos (px)');
    fireEvent.change(gap, { target: { value: '3' } });
    expect(update).toHaveBeenLastCalledWith('premiumGap', 3);
    fireEvent.change(gap, { target: { value: '50' } });
    expect(update).toHaveBeenLastCalledWith('premiumGap', 32);
    update.mockClear();
    fireEvent.change(gap, { target: { value: '' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the spacing select for the other layouts, without Premium fields', () => {
    renderCard({ galleryLayout: 'grid' });
    expect(screen.getByText('branding.photoSpacing')).toBeInTheDocument();
    expect(screen.queryByLabelText('Gap between photos (px)')).toBeNull();
  });
});

describe('HeaderStyleCard — hero photo fit', () => {
  const renderHeader = (theme: ThemeConfig) => {
    const handleChange = vi.fn();
    render(<HeaderStyleCard localTheme={theme} handleChange={handleChange} />);
    return handleChange;
  };

  it('is offered for Premium and for a hero header, filling by default', () => {
    const handleChange = renderHeader({ galleryLayout: 'gallery-premium', headerStyle: 'standard' });
    const fit = screen.getByLabelText('Hero photo');
    expect(fit).toHaveValue('cover');
    fireEvent.change(fit, { target: { value: 'contain' } });
    expect(handleChange).toHaveBeenCalledWith('heroFit', 'contain');
  });

  it('shows a stored whole-photo choice under a hero header', () => {
    renderHeader({ galleryLayout: 'grid', headerStyle: 'hero', heroFit: 'contain' });
    expect(screen.getByLabelText('Hero photo')).toHaveValue('contain');
  });

  it('is not offered without a hero', () => {
    renderHeader({ galleryLayout: 'grid', headerStyle: 'standard' });
    expect(screen.queryByLabelText('Hero photo')).toBeNull();
  });
});
