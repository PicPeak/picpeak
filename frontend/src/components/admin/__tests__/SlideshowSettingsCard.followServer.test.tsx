/**
 * The card's form follows a refetched event while the admin has not touched
 * it, and keeps unsaved edits when one arrives. Before, it read `initial`
 * once on mount, so a change made elsewhere (another admin, another tab)
 * was written back over on the next save (review of the issue 2187 fix).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SlideshowSettingsCard } from '../SlideshowSettingsCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../services/events.service', () => ({
  eventsService: { updateSlideshowSettings: vi.fn(), generateSlideshowLink: vi.fn(), disableSlideshowLink: vi.fn() },
}));
vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));

type Initial = React.ComponentProps<typeof SlideshowSettingsCard>['initial'];

const renderCard = (initial: Initial) => {
  const client = new QueryClient();
  const ui = (next: Initial) => (
    <QueryClientProvider client={client}>
      <SlideshowSettingsCard eventId={7} slug="wedding" initial={next} />
    </QueryClientProvider>
  );
  const view = render(ui(initial));
  return { rerender: (next: Initial) => view.rerender(ui(next)) };
};

const orderSelect = () => screen.getByDisplayValue(/Chronological|Random \(shuffle\)/) as HTMLSelectElement;

describe('SlideshowSettingsCard follows the server', () => {
  it('takes a refetched value while the form is untouched', () => {
    const { rerender } = renderCard({ show_share_token: 'tok', show_order: 'chronological' });
    expect(orderSelect().value).toBe('chronological');

    rerender({ show_share_token: 'tok', show_order: 'random' });
    expect(orderSelect().value).toBe('random');
  });

  it('keeps an unsaved edit when a refetch arrives', () => {
    const { rerender } = renderCard({ show_share_token: 'tok', show_order: 'chronological', show_colorfilter: 'none' });
    fireEvent.change(orderSelect(), { target: { value: 'random' } });

    rerender({ show_share_token: 'tok', show_order: 'chronological', show_colorfilter: 'sepia' });
    expect(orderSelect().value).toBe('random');
  });

  it('shows a link rotated or disabled elsewhere', () => {
    const { rerender } = renderCard({ show_share_token: 'old-token' });
    expect(screen.getByDisplayValue(/old-token/)).toBeTruthy();

    rerender({ show_share_token: 'new-token' });
    expect(screen.getByDisplayValue(/new-token/)).toBeTruthy();

    rerender({ show_share_token: null });
    expect(screen.getByText('Generate slideshow link')).toBeTruthy();
  });
});
