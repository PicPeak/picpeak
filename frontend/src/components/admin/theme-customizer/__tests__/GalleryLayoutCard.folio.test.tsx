/**
 * Gallery Folio in the theme editor (issue 2617): offered in the layout
 * picker, its design options stored in gallerySettings, and the live
 * preview next to the editor following every change.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { GalleryLayoutCard } from '../GalleryLayoutCard';
import { GalleryPreview } from '../../GalleryPreview';
import type { ThemeConfig } from '../../../../types/theme.types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const cardProps = {
  isBetaLayout: false,
  isThumbnailTooSmall: false,
  thumbnailWidth: 0,
  thumbnailHeight: 0,
  minRecommendedThumbnailSize: 0,
};

const renderCard = (theme: ThemeConfig, handleChange = vi.fn(), updateGallerySettings = vi.fn()) => {
  render(<GalleryLayoutCard localTheme={theme} handleChange={handleChange} updateGallerySettings={updateGallerySettings} {...cardProps} />);
  return { handleChange, updateGallerySettings };
};

/** The editor's wiring in small: the card edits the theme, the preview shows it. */
const Editor: React.FC = () => {
  const [theme, setTheme] = useState<ThemeConfig>({ galleryLayout: 'gallery-folio' });
  const updateGallerySettings = (key: string, value: unknown) =>
    setTheme((previous) => ({ ...previous, gallerySettings: { ...previous.gallerySettings, [key]: value } }));
  return (
    <>
      <GalleryLayoutCard
        localTheme={theme}
        handleChange={(key, value) => setTheme((previous) => ({ ...previous, [key]: value }))}
        updateGallerySettings={updateGallerySettings}
        {...cardProps}
      />
      <GalleryPreview theme={theme} />
    </>
  );
};

describe('GalleryLayoutCard — Folio', () => {
  it('offers Folio in the layout picker, marked Beta', () => {
    const { handleChange } = renderCard({ galleryLayout: 'grid' });
    const folio = screen.getByRole('radio', { name: /branding\.layoutNames\.gallery-folio/ });
    expect(folio).toHaveTextContent('Beta');
    fireEvent.click(folio);
    expect(handleChange).toHaveBeenCalledWith('galleryLayout', 'gallery-folio');
  });

  it('shows its options with the defaults, and not the common spacing it ignores', () => {
    renderCard({ galleryLayout: 'gallery-folio' });
    const options = within(screen.getByTestId('folio-settings'));
    expect(options.getByRole('radio', { name: 'branding.folio.covers.full' })).toHaveAttribute('aria-checked', 'true');
    expect(options.getByRole('radio', { name: 'branding.folio.palettes.paper' })).toHaveAttribute('aria-checked', 'true');
    expect(options.getByLabelText('Typography')).toHaveValue('classic');
    expect(options.getByLabelText('Spacing')).toHaveValue('regular');
    expect(options.getByLabelText('branding.folio.columns.mobile')).toHaveValue('2');
    expect(options.getByLabelText('branding.folio.columns.desktop')).toHaveValue('3');
    expect(screen.queryByText('branding.photoSpacing')).toBeNull();
  });

  it.each(['gallery-folio', 'gallery-premium', 'gallery-story', 'masonry', 'carousel', 'timeline', 'mosaic'] as const)(
    'offers no photo animation for %s, which does not animate its photos',
    (galleryLayout) => {
      renderCard({ galleryLayout });
      expect(screen.queryByText('branding.photoAnimation')).toBeNull();
    },
  );

  it('keeps the photo animation for the grid, the layout that reads it', () => {
    renderCard({ galleryLayout: 'grid' });
    expect(screen.getByText('branding.photoAnimation')).toBeInTheDocument();
  });

  it('stores each option under its folio key', () => {
    const { updateGallerySettings } = renderCard({ galleryLayout: 'gallery-folio' });
    fireEvent.click(screen.getByRole('radio', { name: 'branding.folio.covers.split' }));
    expect(updateGallerySettings).toHaveBeenLastCalledWith('folioCover', 'split');
    fireEvent.click(screen.getByRole('radio', { name: 'branding.folio.palettes.charcoal' }));
    expect(updateGallerySettings).toHaveBeenLastCalledWith('folioPalette', 'charcoal');
    fireEvent.change(screen.getByLabelText('Typography'), { target: { value: 'modern' } });
    expect(updateGallerySettings).toHaveBeenLastCalledWith('folioType', 'modern');
    fireEvent.change(screen.getByLabelText('Spacing'), { target: { value: 'airy' } });
    expect(updateGallerySettings).toHaveBeenLastCalledWith('folioSpacing', 'airy');
    fireEvent.change(screen.getByLabelText('branding.folio.columns.desktop'), { target: { value: '4' } });
    expect(updateGallerySettings).toHaveBeenLastCalledWith('folioColumns', { mobile: 2, desktop: 4 });
    fireEvent.change(screen.getByLabelText('Studio label'), { target: { value: 'Studio Nord' } });
    expect(updateGallerySettings).toHaveBeenLastCalledWith('folioStudioLabel', 'Studio Nord');
  });

  it('offers only 1–2 columns on a phone and 2–4 on a desktop', () => {
    renderCard({ galleryLayout: 'gallery-folio' });
    const values = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value);
    expect(values('branding.folio.columns.mobile')).toEqual(['1', '2']);
    expect(values('branding.folio.columns.desktop')).toEqual(['2', '3', '4']);
  });

  it('updates the live preview as the options change', () => {
    render(<Editor />);
    const preview = () => screen.getByTestId('folio-preview');
    expect(preview()).toHaveAttribute('data-palette', 'paper');
    expect(preview()).toHaveAttribute('data-cover', 'full');

    fireEvent.click(screen.getByRole('radio', { name: 'branding.folio.palettes.charcoal' }));
    expect(preview()).toHaveAttribute('data-palette', 'charcoal');
    expect(preview()).toHaveStyle({ backgroundColor: '#1c1c1b' });

    fireEvent.click(screen.getByRole('radio', { name: 'branding.folio.covers.split' }));
    expect(preview()).toHaveAttribute('data-cover', 'split');

    fireEvent.change(screen.getByLabelText('branding.folio.columns.desktop'), { target: { value: '2' } });
    expect(preview()).toHaveAttribute('data-columns', '2');

    fireEvent.change(screen.getByLabelText('Studio label'), { target: { value: 'Studio Nord' } });
    expect(within(preview()).getByText('Studio Nord')).toBeInTheDocument();
  });
});
