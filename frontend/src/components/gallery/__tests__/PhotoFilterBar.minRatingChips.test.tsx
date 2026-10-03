/**
 * Own-rating filter chips in the filter bar (issue 1733, A3c). They sit next
 * to the colour chips, switched by the same `allowRatings` option as the
 * tile's star control, and never render while ratings are off.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PhotoFilterBar } from '../PhotoFilterBar';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: unknown, opts?: Record<string, unknown>) =>
        typeof fallback === 'string'
          ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''))
          : _key,
      i18n: { language: 'en' }
    })
  };
});

const baseProps = {
  categories: [] as Array<{ id: number; name: string; slug: string }>,
  photos: [] as never[],
  selectedCategoryId: null,
  onCategoryChange: vi.fn(),
  searchTerm: '',
  onSearchChange: vi.fn(),
  sortBy: 'date' as const,
  onSortChange: vi.fn(),
  photoCount: 0,
  feedbackEnabled: true,
  activeFilters: [],
  onFilterChange: vi.fn(),
};

// One photo rated 4: thresholds 1..4 are reachable, 5 is not.
const counts = { 1: 1, 2: 1, 3: 1, 4: 1 };

describe('PhotoFilterBar own-rating chips (issue 1733)', () => {
  it('renders the chips (desktop + mobile groups) when ratings are on', () => {
    render(
      <PhotoFilterBar
        {...baseProps}
        ratingsEnabled
        minRating={null}
        onMinRatingChange={vi.fn()}
        minRatingCounts={counts}
      />
    );
    expect(screen.getAllByText('My rating')).toHaveLength(2);
    // The unreachable "5" chip is hidden, like an unused colour swatch.
    expect(screen.getAllByRole('button', { name: 'My rating: 3 stars or more' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'My rating: 5 stars or more' })).toBeNull();
  });

  it('hides the chips when ratings are off for the event', () => {
    render(
      <PhotoFilterBar
        {...baseProps}
        ratingsEnabled={false}
        minRating={null}
        onMinRatingChange={vi.fn()}
        minRatingCounts={counts}
      />
    );
    expect(screen.queryByText('My rating')).toBeNull();
    // The rest of the feedback filter is untouched by the switch.
    expect(screen.getAllByText('Feedback Filter')).toHaveLength(2);
  });

  it('hides the chips when feedback as a whole is off, even with ratings flagged on', () => {
    render(
      <PhotoFilterBar
        {...baseProps}
        feedbackEnabled={false}
        ratingsEnabled
        minRating={null}
        onMinRatingChange={vi.fn()}
        minRatingCounts={counts}
      />
    );
    expect(screen.queryByText('My rating')).toBeNull();
  });

  it('sets the threshold on click and clears it on a second click', () => {
    const onMinRatingChange = vi.fn();
    const { rerender } = render(
      <PhotoFilterBar
        {...baseProps}
        ratingsEnabled
        minRating={null}
        onMinRatingChange={onMinRatingChange}
        minRatingCounts={counts}
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'My rating: 3 stars or more' })[0]);
    expect(onMinRatingChange).toHaveBeenLastCalledWith(3);

    rerender(
      <PhotoFilterBar
        {...baseProps}
        ratingsEnabled
        minRating={3}
        onMinRatingChange={onMinRatingChange}
        minRatingCounts={counts}
      />
    );
    const active = screen.getAllByRole('button', { name: 'My rating: 3 stars or more' })[0];
    expect(active).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(active);
    expect(onMinRatingChange).toHaveBeenLastCalledWith(null);
  });
});
