/**
 * The gallery filter panel (issue 1733, E7): the feedback, colour, own-rating,
 * media, credit and tag filters in one place, ending in "Select these N
 * photos". Each group renders only when the container passes its slice; the
 * own-rating chips (A3c) carry over the cases the old filter bar pinned.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GalleryFilterPanel } from '../GalleryFilterPanel';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
        if (typeof fallback === 'string') {
          return fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''));
        }
        const count = (fallback as { count?: number } | undefined)?.count;
        return count === undefined ? key : `${key}:${count}`;
      },
      i18n: { language: 'en' }
    })
  };
});

const feedback = { activeFilters: [], onFilterChange: vi.fn() };
// One photo rated 4: thresholds 1..4 are reachable, 5 is not.
const counts = { 1: 1, 2: 1, 3: 1, 4: 1 };

describe('GalleryFilterPanel', () => {
  it('renders only the groups it is handed', () => {
    render(<GalleryFilterPanel matchCount={3} feedback={feedback} />);
    expect(screen.getByText('Feedback Filter')).toBeInTheDocument();
    expect(screen.queryByText('My rating')).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
  });

  it('toggles a feedback filter and marks the active one', () => {
    const onFilterChange = vi.fn();
    render(<GalleryFilterPanel matchCount={3} feedback={{ activeFilters: ['liked'], onFilterChange }} />);
    const likes = screen.getByRole('button', { name: 'Likes' });
    expect(likes).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Saved' }));
    expect(onFilterChange).toHaveBeenCalledWith('favorited');
  });

  it('ends in "Select these N photos" with the number the filters leave', () => {
    const onSelectMatches = vi.fn();
    render(<GalleryFilterPanel matchCount={7} feedback={feedback} onSelectMatches={onSelectMatches} />);
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filterPanel.selectMatches:7' }));
    expect(onSelectMatches).toHaveBeenCalledTimes(1);
  });

  it('says items, not photos, once videos are among the matches', () => {
    render(<GalleryFilterPanel matchCount={2} hasVideos onSelectMatches={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'gallery.filterPanel.selectMatchesMedia:2' })).toBeInTheDocument();
  });

  it('cannot select an empty result, and offers no select step without selection', () => {
    const { rerender } = render(<GalleryFilterPanel matchCount={0} onSelectMatches={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'gallery.filterPanel.selectMatches:0' })).toBeDisabled();
    rerender(<GalleryFilterPanel matchCount={4} feedback={feedback} />);
    expect(screen.queryByRole('button', { name: /selectMatches/ })).toBeNull();
  });

  it('offers "Clear filters" only while a filter is set', () => {
    const onClearFilters = vi.fn();
    const { rerender } = render(<GalleryFilterPanel matchCount={4} feedback={feedback} onClearFilters={onClearFilters} />);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    rerender(<GalleryFilterPanel matchCount={4} feedback={feedback} filtersActive onClearFilters={onClearFilters} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('sets the media filter', () => {
    const onChange = vi.fn();
    render(<GalleryFilterPanel matchCount={4} media={{ value: 'all', onChange }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Videos' }));
    expect(onChange).toHaveBeenCalledWith('video');
  });

  describe('own-rating chips (issue 1733, A3c)', () => {
    it('renders the chips, hiding thresholds nothing reaches', () => {
      render(<GalleryFilterPanel matchCount={1} minRating={{ value: null, onChange: vi.fn(), counts }} />);
      expect(screen.getByText('My rating')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'My rating: 3 stars or more' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'My rating: 5 stars or more' })).toBeNull();
    });

    it('sets the threshold on click and clears it on a second click', () => {
      const onChange = vi.fn();
      const { rerender } = render(<GalleryFilterPanel matchCount={1} minRating={{ value: null, onChange, counts }} />);
      fireEvent.click(screen.getByRole('button', { name: 'My rating: 3 stars or more' }));
      expect(onChange).toHaveBeenLastCalledWith(3);

      rerender(<GalleryFilterPanel matchCount={1} minRating={{ value: 3, onChange, counts }} />);
      const active = screen.getByRole('button', { name: 'My rating: 3 stars or more' });
      expect(active).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(active);
      expect(onChange).toHaveBeenLastCalledWith(null);
    });
  });
});
