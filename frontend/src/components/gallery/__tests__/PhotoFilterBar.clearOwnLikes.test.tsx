/**
 * "Remove my likes" next to the toolbar's feedback filter (issue 2561), in
 * both the desktop row and the mobile/tablet block (one of them is hidden
 * by breakpoint classes, so both are in the DOM).
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PhotoFilterBar } from '../PhotoFilterBar';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => (opts && typeof opts === 'object' && 'count' in opts ? `${key}:${(opts as { count: number }).count}` : key),
    i18n: { language: 'en' },
  }),
}));

const renderBar = (clearOwnLikes?: { count: number; onClick: () => void }) => render(
  <PhotoFilterBar
    photos={[]}
    selectedCategoryId={null}
    onCategoryChange={() => {}}
    searchTerm=""
    onSearchChange={() => {}}
    sortBy="date"
    onSortChange={() => {}}
    photoCount={3}
    feedbackEnabled
    activeFilters={[]}
    feedbackFilters={['liked']}
    onFilterChange={() => {}}
    clearOwnLikes={clearOwnLikes}
  />,
);

describe('PhotoFilterBar remove my likes (issue 2561)', () => {
  it('offers the step in the desktop row and the mobile block', () => {
    const onClick = vi.fn();
    renderBar({ count: 2, onClick });
    const buttons = screen.getAllByRole('button', { name: 'gallery.filterPanel.clearLikes:2' });
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => fireEvent.click(button));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('leaves it out without own likes or when likes are off', () => {
    const { unmount } = renderBar({ count: 0, onClick: vi.fn() });
    expect(screen.queryByRole('button', { name: /clearLikes/ })).toBeNull();
    unmount();
    renderBar(undefined);
    expect(screen.queryByRole('button', { name: /clearLikes/ })).toBeNull();
  });
});
