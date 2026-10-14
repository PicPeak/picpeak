/**
 * The Story layout's settings in the theme editor: the filename caption is a
 * switch in the draft, off unless the theme stored it on.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GalleryLayoutCard } from '../GalleryLayoutCard';
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

describe('GalleryLayoutCard — Story settings', () => {
  it('shows the filename switch off when the theme has no value, and turns it on in the draft', () => {
    const update = renderCard({ galleryLayout: 'gallery-story' });
    const toggle = screen.getByRole('switch', { name: 'Show filenames on hover' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledWith('storyShowFilenames', true);
  });

  it('reflects a stored value and turns it off again', () => {
    const update = renderCard({ galleryLayout: 'gallery-story', gallerySettings: { storyShowFilenames: true } });
    const toggle = screen.getByRole('switch', { name: 'Show filenames on hover' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledWith('storyShowFilenames', false);
  });

  it('is offered for the Story layout only', () => {
    renderCard({ galleryLayout: 'gallery-premium' });
    expect(screen.queryByRole('switch', { name: 'Show filenames on hover' })).toBeNull();
  });
});
