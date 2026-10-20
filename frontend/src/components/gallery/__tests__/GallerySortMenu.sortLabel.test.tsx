/**
 * The sort button's name (issue 2074). The gallery.sortBy* strings are whole
 * phrases, so gluing "Sortieren nach" in front read "Sortieren nach Nach
 * Datum sortieren" in German, and below md the visible text is hidden, which
 * left the button with no name at all.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GallerySortMenu } from '../GallerySortMenu';

const DE: Record<string, string> = {
  'common.sortBy': 'Sortieren nach',
  'gallery.sortByDate': 'Nach Datum sortieren',
  'gallery.sortByName': 'Nach Name sortieren',
};

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) =>
        DE[key] ?? (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'de' }
    })
  };
});

describe('GallerySortMenu sort button name (issue 2074)', () => {
  it('names the button with the phrase once, with no doubled "sort by"', () => {
    render(<GallerySortMenu sortBy="date" onSortChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Nach Datum sortieren' });
    expect(button).toHaveAttribute('aria-label', 'Nach Datum sortieren');
    expect(button.textContent).toBe('Nach Datum sortieren');
    expect(screen.queryByText(/Sortieren nach Nach/)).toBeNull();
  });

  it('follows the applied sort', () => {
    render(<GallerySortMenu sortBy="name" onSortChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Nach Name sortieren' })).toBeInTheDocument();
  });
});
