/**
 * Issue 2043: the sidebar's "Download selected" spins and ignores clicks
 * while the selection is being downloaded.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GallerySidebar } from '../GallerySidebar';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) };
});

function sidebar(isDownloadingSelected: boolean, onDownloadSelected: () => void) {
  return (
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
      isSelectionMode
      onToggleSelectionMode={() => {}}
      selectedCount={1}
      onDownloadAll={() => {}}
      onDownloadSelected={onDownloadSelected}
      isDownloading={false}
      isDownloadingSelected={isDownloadingSelected}
      allowDownloads
      totalPhotos={3}
      isMobile={false}
    />
  );
}

function renderSidebar(isDownloadingSelected: boolean, onDownloadSelected = vi.fn()) {
  const view = render(sidebar(isDownloadingSelected, onDownloadSelected));
  return { view, onDownloadSelected, button: screen.getByText(/gallery\.downloadSelected/).closest('button')! };
}

describe('GallerySidebar "Download selected" busy state (issue 2043)', () => {
  it('spins, is marked busy and ignores clicks while the download runs', () => {
    const { button, onDownloadSelected } = renderSidebar(true);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.querySelector('.animate-spin')).not.toBeNull();
    fireEvent.click(button);
    expect(onDownloadSelected).not.toHaveBeenCalled();
  });

  it('is an ordinary button otherwise', () => {
    const { button, onDownloadSelected } = renderSidebar(false);
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button.querySelector('.animate-spin')).toBeNull();
    fireEvent.click(button);
    expect(onDownloadSelected).toHaveBeenCalledTimes(1);
  });

  it('keeps keyboard focus on the button when it goes busy', () => {
    const { view, button, onDownloadSelected } = renderSidebar(false);
    button.focus();
    view.rerender(sidebar(true, onDownloadSelected));
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
  });
});
