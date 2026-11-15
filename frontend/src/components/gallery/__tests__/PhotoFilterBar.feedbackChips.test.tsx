/**
 * Regression coverage for #802: the desktop feedback-filter chips
 * (All / Likes / Saved / Rated / Commented) were nested inside the
 * categories row, so a gallery WITHOUT photo categories (the default)
 * rendered no feedback filter at all on desktop — the standalone
 * fallback block is lg:hidden (mobile/tablet only). These tests pin
 * that both chip groups exist in the DOM regardless of categories.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PhotoFilterBar } from '../PhotoFilterBar';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: unknown) =>
        typeof fallback === 'string' ? fallback : _key,
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
};

describe('PhotoFilterBar feedback chips (#802)', () => {
  it('renders both chip groups (desktop lg:flex + mobile lg:hidden) with NO categories', () => {
    render(
      <PhotoFilterBar
        {...baseProps}
        feedbackEnabled
        activeFilters={[]}
        onFilterChange={vi.fn()}
      />
    );
    // Two groups: the desktop row variant and the mobile fallback. Before
    // the fix, only the mobile one rendered when categories were empty,
    // leaving desktop with no feedback filter at all.
    expect(screen.getAllByText('Feedback Filter')).toHaveLength(2);
  });

  it('still renders both chip groups when categories exist', () => {
    render(
      <PhotoFilterBar
        {...baseProps}
        categories={[{ id: 1, name: 'Ceremony', slug: 'ceremony' }]}
        photos={[{ id: 1, category_id: 1 } as never]}
        feedbackEnabled
        activeFilters={[]}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.getAllByText('Feedback Filter')).toHaveLength(2);
  });

  it('renders no chips when feedback is disabled', () => {
    render(<PhotoFilterBar {...baseProps} />);
    expect(screen.queryByText('Feedback Filter')).toBeNull();
  });

  // Issue 2505: only the filters the gallery's feedback settings allow.
  it('offers only the allowed feedback filters in both groups', () => {
    render(
      <PhotoFilterBar
        {...baseProps}
        feedbackEnabled
        activeFilters={[]}
        feedbackFilters={['liked']}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.getAllByRole('button', { name: 'Likes' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rated' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Commented' })).toBeNull();
  });

  it('renders no feedback chips when no filter is allowed', () => {
    render(
      <PhotoFilterBar
        {...baseProps}
        feedbackEnabled
        activeFilters={[]}
        feedbackFilters={[]}
        onFilterChange={vi.fn()}
      />
    );
    expect(screen.queryByText('Feedback Filter')).toBeNull();
  });

  it('keeps the desktop colour chips when no feedback filter is allowed', () => {
    const { container } = render(
      <PhotoFilterBar
        {...baseProps}
        feedbackEnabled
        activeFilters={[]}
        feedbackFilters={[]}
        onFilterChange={vi.fn()}
        colorLabelsEnabled
        activeColorFilters={[]}
        onColorFilterChange={vi.fn()}
        colorLabelCounts={{ red: 2 }}
      />
    );
    // The desktop chips carry `hidden lg:flex`; the mobile ones `lg:hidden`.
    expect(container.querySelector('.lg\\:flex')).not.toBeNull();
  });
});
