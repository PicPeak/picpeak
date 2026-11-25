/**
 * The sidebar's feedback filter (issue 2505) shows only the filters the
 * gallery's feedback settings allow, and nothing when none is allowed.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GalleryFilter } from '../GalleryFilter';

vi.mock('../FavoriteListSwitcher', () => ({ FavoriteListSwitcher: () => null }));
vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key, i18n: { language: 'en' } }),
}));

const props = { activeFilters: [], onFilterChange: vi.fn(), feedbackEnabled: true };

describe('GalleryFilter', () => {
  it('offers only the allowed filters', () => {
    render(<GalleryFilter {...props} available={['liked']} />);
    expect(screen.getByRole('button', { name: /Likes/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Saved/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Rated/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Commented/ })).toBeNull();
  });

  it('renders nothing when no filter is allowed', () => {
    const { container } = render(<GalleryFilter {...props} available={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
