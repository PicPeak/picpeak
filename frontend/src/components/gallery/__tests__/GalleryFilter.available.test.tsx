/**
 * The sidebar's feedback filter (issue 2505) shows only the filters the
 * gallery's feedback settings allow, in all three variants, and nothing
 * when none is allowed.
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

describe.each([
  ['compact', { variant: 'compact' as const }, { liked: 'Likes', favorited: 'Saved', rated: 'Rated' }],
  ['mobile', { isMobile: true }, { liked: 'Liked', favorited: 'Saved', rated: 'Rated' }],
  ['desktop', {}, { liked: 'Liked', favorited: 'Saved', rated: 'Rated' }],
])('GalleryFilter, %s', (_label, variant, names) => {
  it('offers only the allowed filters', () => {
    render(<GalleryFilter {...props} {...variant} available={['liked']} />);
    expect(screen.getByRole('button', { name: new RegExp(names.liked) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(names.favorited) })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(names.rated) })).toBeNull();
    expect(screen.queryByRole('button', { name: /Commented/ })).toBeNull();
  });

  it('renders nothing when no filter is allowed', () => {
    const { container } = render(<GalleryFilter {...props} {...variant} available={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
