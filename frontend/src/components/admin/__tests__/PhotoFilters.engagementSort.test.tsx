import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoFilters } from '../PhotoFilters';
import type { PhotoSortKey } from '../../../services/photos.service';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key, i18n: { language: 'en' } }),
}));

const props = () => ({
  categories: [], selectedCategory: null, searchTerm: '', sortBy: 'date' as PhotoSortKey,
  sortOrder: 'desc' as const, onCategoryChange: vi.fn(), onSearchChange: vi.fn(), onSortChange: vi.fn(),
});
const metrics: PhotoSortKey[] = ['likes', 'favorites', 'downloads'];

afterEach(cleanup);

describe('PhotoFilters engagement sorting', () => {
  it.each(metrics)('offers %s with either existing direction', async (sort) => {
    const p = props();
    const { rerender } = render(<PhotoFilters {...p} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort photos' }), sort);
    expect(p.onSortChange).toHaveBeenLastCalledWith(sort, 'desc');

    rerender(<PhotoFilters {...p} sortOrder="asc" />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort photos' }), sort);
    expect(p.onSortChange).toHaveBeenLastCalledWith(sort, 'asc');
  });

  it.each(metrics)('toggles the direction without losing the %s metric', async (sortBy) => {
    const p = props();
    const { rerender } = render(<PhotoFilters {...p} sortBy={sortBy} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sort ascending' }));
    expect(p.onSortChange).toHaveBeenLastCalledWith(sortBy, 'asc');

    rerender(<PhotoFilters {...p} sortBy={sortBy} sortOrder="asc" />);
    await userEvent.click(screen.getByRole('button', { name: 'Sort descending' }));
    expect(p.onSortChange).toHaveBeenLastCalledWith(sortBy, 'desc');
  });

  it('retains every existing sort option', () => {
    render(<PhotoFilters {...props()} />);
    expect(Array.from((screen.getByRole('combobox', { name: 'Sort photos' }) as HTMLSelectElement).options)
      .map((o) => o.value)).toEqual(['date', 'capture_date', 'name', 'size', 'rating', 'likes', 'favorites', 'downloads']);
  });
});
