/**
 * Surfacing duplicate guests in the admin list (#1210).
 *
 * Merging two rows into one already worked. What the admin had no way to see
 * was WHICH rows were the same person — so a client who registered again after
 * their token expired left their picks split across two entries, and the
 * "final selection" was only trustworthy if someone happened to notice.
 *
 * The banner offers the group to the merge mode that already exists; it does
 * not merge anything. Which row survives decides the name and verification
 * state the merged guest keeps, and that is the admin's call.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { AdminGuestsList } from '../AdminGuestsList';

const getEventGuests = vi.fn();

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => {
        if (typeof fallback === 'string') return fallback;
        if (fallback && typeof fallback === 'object' && 'defaultValue' in fallback) {
          return String(fallback.defaultValue)
            .replace('{{guests}}', String(fallback.guests))
            .replace('{{groups}}', String(fallback.groups));
        }
        return _key;
      },
      i18n: { language: 'en' }
    })
  };
});

vi.mock('../../../services/guests.service', () => ({
  guestsService: {
    getEventGuests: (...a: any[]) => getEventGuests(...a),
    deleteGuest: vi.fn(),
    mergeGuests: vi.fn(),
    exportGuest: vi.fn(),
    exportAllGuests: vi.fn(),
  }
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const guest = (
  id: number,
  name: string,
  email: string | null,
  duplicate_group: string | null = null,
  extra: Partial<{ email_verified_at: string | null; created_at: string; distinct_photos: number }> = {},
) => ({
  id, name, email, duplicate_group,
  created_at: extra.created_at ?? '2026-08-01T10:00:00Z',
  last_seen_at: '2026-08-02T10:00:00Z',
  email_verified_at: extra.email_verified_at ?? null,
  is_deleted: false,
  stats: {
    likes: 3, favorites: 1, comments: 0, ratings: 0, reactions: 0, color_labels: 0,
    distinct_photos: extra.distinct_photos ?? 3,
  },
});

const renderList = () => render(<AdminGuestsList eventId={7} eventName="Test" />, { wrapper });

describe('duplicate guests in the admin list (#1210)', () => {
  beforeEach(() => {
    getEventGuests.mockReset();
    // Calls leak between cases otherwise — the survivor test below performs a
    // real merge, and the "does not merge on its own" case asserts on the
    // absence of exactly that call.
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('says how many entries look like returning visitors', async () => {
    getEventGuests.mockResolvedValue({
      guests: [guest(1, 'Tina', 'tina@example.com', 'tina@example.com'), guest(2, 'Tina', 'tina@example.com', 'tina@example.com')],
      duplicates: { groups: 1, guests: 2 },
    });

    renderList();

    expect(await screen.findByText(/2 guest entries look like 1 returning visitor/i)).toBeInTheDocument();
  });

  it('badges the rows the banner is talking about', async () => {
    getEventGuests.mockResolvedValue({
      guests: [
        guest(1, 'Tina', 'tina@example.com', 'tina@example.com'),
        guest(2, 'Tina', 'tina@example.com', 'tina@example.com'),
        guest(3, 'Marc', 'marc@example.com'),
      ],
      duplicates: { groups: 1, guests: 2 },
    });

    renderList();

    // Two badged, and Marc left alone — the banner's claim is checkable
    // against the rows rather than being taken on trust.
    expect(await screen.findAllByText(/duplicate\?/i)).toHaveLength(2);
  });

  it('stays out of the way when nobody is duplicated', async () => {
    getEventGuests.mockResolvedValue({
      guests: [guest(1, 'Tina', 'tina@example.com'), guest(2, 'Marc', 'marc@example.com')],
      duplicates: { groups: 0, guests: 0 },
    });

    renderList();

    expect(await screen.findByText('Marc')).toBeInTheDocument();
    expect(screen.queryByText(/returning visitor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/duplicate\?/i)).not.toBeInTheDocument();
  });

  it('proposes the verified row as the survivor, not the newest', async () => {
    // performMerge keeps mergeSelection[0] and soft-deletes the rest, so the
    // order this preselects decides who survives. The API returns newest-first;
    // taking that order would discard an older, email-verified row holding most
    // of the picks in favour of a fresh re-registration. Asserted through the
    // call the merge actually makes, since the selection order is not otherwise
    // visible in the DOM.
    const { guestsService } = await import('../../../services/guests.service');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    getEventGuests.mockResolvedValue({
      guests: [
        guest(2, 'Tina', 'tina@example.com', 'tina@example.com',
          { created_at: '2026-08-05T19:44:00Z', distinct_photos: 4 }),
        guest(1, 'Tina Ferrarelli', 'tina@example.com', 'tina@example.com',
          { email_verified_at: '2026-08-01T10:14:00Z', created_at: '2026-08-01T10:12:00Z', distinct_photos: 21 }),
      ],
      duplicates: { groups: 1, guests: 2 },
    });

    renderList();
    await userEvent.click(await screen.findByRole('button', { name: /^Review$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /merge selected/i }));

    // keepId 1 — the verified row with 21 photos — absorbs the newer one.
    expect(guestsService.mergeGuests).toHaveBeenCalledWith(7, 1, [2]);
  });

  it('hands the group to the merge flow instead of merging on its own', async () => {
    const { guestsService } = await import('../../../services/guests.service');
    getEventGuests.mockResolvedValue({
      guests: [guest(1, 'Tina', 'tina@example.com', 'tina@example.com'), guest(2, 'Tina', 'tina@example.com', 'tina@example.com')],
      duplicates: { groups: 1, guests: 2 },
    });

    renderList();
    await userEvent.click(await screen.findByRole('button', { name: /^Review$/i }));

    // Merge mode is open with the pair preselected, and nothing has been
    // merged — the admin still chooses which row survives.
    expect(guestsService.mergeGuests).not.toHaveBeenCalled();
    expect(screen.queryByText(/returning visitor/i)).not.toBeInTheDocument();
  });
});
