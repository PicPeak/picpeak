/**
 * "Remove my likes" in the sidebar (issue 2561): galleries with
 * controlsStyle 'sidebar' have no toolbar filter bar, so the sidebar's
 * feedback section offers the same step while the viewer has a like.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GallerySidebar } from '../GallerySidebar';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => (opts && typeof opts === 'object' && 'count' in opts ? `${key}:${(opts as { count: number }).count}` : key),
    i18n: { language: 'en' },
  }),
}));

const renderSidebar = (clearOwnLikes?: { count: number; onClick: () => void }) => render(
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
    allowDownloads
    totalPhotos={3}
    isMobile={false}
    feedbackEnabled
    activeFilters={[]}
    onFilterChange={() => {}}
    clearOwnLikes={clearOwnLikes}
  />,
);

describe('GallerySidebar remove my likes (issue 2561)', () => {
  it('offers the step with the own like count and hands the click to the container', () => {
    const onClick = vi.fn();
    renderSidebar({ count: 3, onClick });
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filterPanel.clearLikes:3' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('leaves it out without own likes or when likes are off', () => {
    const { unmount } = renderSidebar({ count: 0, onClick: vi.fn() });
    expect(screen.queryByRole('button', { name: /clearLikes/ })).toBeNull();
    unmount();
    renderSidebar(undefined);
    expect(screen.queryByRole('button', { name: /clearLikes/ })).toBeNull();
  });
});
