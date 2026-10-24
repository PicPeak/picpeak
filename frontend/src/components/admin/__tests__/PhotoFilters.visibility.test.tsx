import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoFilters } from '../PhotoFilters';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key, i18n: { language: 'en' } }),
}));

const props = () => ({
  categories: [], selectedCategory: null, searchTerm: '', sortBy: 'date' as const,
  sortOrder: 'desc' as const, onCategoryChange: vi.fn(), onSearchChange: vi.fn(),
  onSortChange: vi.fn(), onVisibilityChange: vi.fn(),
});
afterEach(cleanup);

describe('PhotoFilters visibility', () => {
  it('defaults to All Photos and offers both visibility states', () => {
    render(<PhotoFilters {...props()} />);
    const select = screen.getByRole('combobox', { name: 'Photo visibility' }) as HTMLSelectElement;
    expect(select.value).toBe('all');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['All Photos', 'Visible Photos', 'Hidden Photos']);
  });

  it.each(['all', 'visible', 'hidden'] as const)('reports the %s choice and follows its controlled value', async (visibility) => {
    const p = props();
    const { rerender } = render(<PhotoFilters {...p} visibility="hidden" />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Photo visibility' }), visibility);
    expect(p.onVisibilityChange).toHaveBeenLastCalledWith(visibility);
    rerender(<PhotoFilters {...p} visibility={visibility} />);
    expect(screen.getByRole('combobox', { name: 'Photo visibility' })).toHaveValue(visibility);
    expect(p.onSortChange).not.toHaveBeenCalled();
    expect(p.onCategoryChange).not.toHaveBeenCalled();
  });
});
