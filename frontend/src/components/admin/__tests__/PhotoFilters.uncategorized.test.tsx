/**
 * The category filter's wire values (#1211).
 *
 * "Uncategorized" was rendered as `value="0"`, and the backend skips `'0'`
 * outright (`adminPhotos.js`: `category_id !== '0'`), so the filter applied no
 * condition and returned the whole event. The value it does understand is the
 * literal `uncategorized`, four lines below that guard, which nothing sent.
 *
 * The failure was silent — a full list reads as "nothing to narrow" rather
 * than "the filter did not run" — so this pins the wire value rather than the
 * rendered label. Reported in #1209 by someone trying to isolate a few
 * thousand uncategorised imports to re-assign them.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PhotoFilters } from '../PhotoFilters';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' }
    })
  };
});

const categories = [
  { id: 3, name: 'Ceremony' },
  { id: 4, name: 'Reception' },
];

const renderFilters = (selectedCategory: number | string | null = null) => {
  const onCategoryChange = vi.fn();
  render(
    <PhotoFilters
      selectedCategory={selectedCategory}
      categories={categories as any}
      onCategoryChange={onCategoryChange}
      searchTerm=""
      onSearchChange={vi.fn()}
    />
  );
  return { onCategoryChange };
};

const categorySelect = () => screen.getAllByRole('combobox')[0];

describe('category filter wire values (#1211)', () => {
  it('sends the literal the backend understands for Uncategorized', async () => {
    const { onCategoryChange } = renderFilters();

    await userEvent.selectOptions(categorySelect(), 'uncategorized');

    // Not 0 — the backend drops that and returns everything.
    expect(onCategoryChange).toHaveBeenCalledWith('uncategorized');
  });

  it('still sends a numeric id for a real category', async () => {
    const { onCategoryChange } = renderFilters();

    await userEvent.selectOptions(categorySelect(), '3');

    expect(onCategoryChange).toHaveBeenCalledWith(3);
  });

  it('clears back to null for All Categories', async () => {
    const { onCategoryChange } = renderFilters('uncategorized');

    await userEvent.selectOptions(categorySelect(), '');

    expect(onCategoryChange).toHaveBeenCalledWith(null);
  });

  it('keeps Uncategorized selected once it is chosen', () => {
    renderFilters('uncategorized');
    // The select is controlled; if the option value and the state value ever
    // drift apart the control silently falls back to the first option.
    expect((categorySelect() as HTMLSelectElement).value).toBe('uncategorized');
  });
});
