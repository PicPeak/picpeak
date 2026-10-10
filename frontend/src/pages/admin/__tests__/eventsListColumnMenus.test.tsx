/**
 * /admin/events was ordered `created_at desc` for everyone, with no control to
 * change it: the table rendered an event-date column that had no influence on
 * the order, so a back-filled archive (last year's weddings, imported today)
 * listed in import order and nothing else.
 *
 * These pin the contract of the column menus that replace the static headers:
 * every choice is a server query param, the type filter is one too, and
 * changing any of them starts again at page 1 rather than leaving the admin on
 * a page index that means something different now.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmDialogProvider } from '../../../components/common/ConfirmDialog';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('../../../hooks/usePublicSettings', () => ({
  PUBLIC_SETTINGS_QUERY_KEY: ['public-settings'],
  usePublicSettings: () => ({ data: {} }),
}));

vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: () => true,
    hasAnyPermission: () => true,
    hasAllPermissions: () => true,
    isSuperAdmin: true,
    isLoading: false,
  }),
}));

const getEvents = vi.fn();
vi.mock('../../../services/events.service', () => ({
  eventsService: {
    getEvents: (...args: unknown[]) => getEvents(...args),
    archiveEvent: vi.fn(),
    deleteEvent: vi.fn(),
    duplicateEvent: vi.fn(),
  },
}));

vi.mock('../../../services/eventTypes.service', () => ({
  eventTypesService: {
    getEventTypes: vi.fn().mockResolvedValue([
      { id: 1, name: 'Wedding', slug_prefix: 'wedding', emoji: '', is_active: true },
      // Deactivated, and still offered: galleries created before it was switched
      // off still carry the slug and would otherwise be unfilterable.
      { id: 2, name: 'Baptism', slug_prefix: 'baptism', emoji: '', is_active: false },
    ]),
  },
}));

vi.mock('../../../services/admin.service', () => ({
  adminService: { getDashboardStats: vi.fn().mockResolvedValue({ totalEvents: 42 }) },
}));

import { EventsListPage } from '../EventsListPage';

const event = (id: number, event_name: string) => ({
  id,
  slug: `slug-${id}`,
  event_name,
  event_type: 'wedding',
  event_date: '2026-08-01',
  customer_email: 'k@example.com',
  expires_at: '2026-12-01T00:00:00.000Z',
  photo_count: 3,
  is_active: true,
  is_archived: false,
  is_draft: false,
  require_password: true,
});

const listPage = (rows: unknown[], total = rows.length) => ({
  events: rows,
  pagination: { page: 1, limit: 20, total, totalPages: Math.ceil(total / 20) },
});

function renderPage(entry = '/admin/events') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <ConfirmDialogProvider>
          <EventsListPage />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Opens a column menu by its trigger's accessible name. */
async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }));
}

describe('events list column menus', () => {
  beforeEach(() => {
    getEvents.mockReset();
    getEvents.mockResolvedValue(listPage([event(1, 'Hochzeit Meier')], 40));
  });

  it('asks the server for nothing in particular until a column is chosen', async () => {
    renderPage();
    await waitFor(() => expect(getEvents).toHaveBeenCalled());
    // No sort params: the backend applies its own default rather than the page
    // guessing one and disagreeing with it.
    expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, sortBy: undefined, sortOrder: undefined, type: undefined }),
    );
  });

  it('sends the chosen event-date direction to the server', async () => {
    renderPage();
    await openMenu('events.date');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Oldest first' }));

    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'event_date', sortOrder: 'asc' }),
    ));
  });

  it('offers creation order from the same menu, on a different column', async () => {
    renderPage();
    await openMenu('events.date');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Recently created' }));

    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'created_at', sortOrder: 'desc' }),
    ));
  });

  it('sorts by photo count and by status, which are expressions server-side', async () => {
    renderPage();
    await openMenu('Photos');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Most photos' }));
    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'photo_count', sortOrder: 'desc' }),
    ));

    await openMenu('events.status');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Active first' }));
    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'status', sortOrder: 'asc' }),
    ));
  });

  it('filters by type, including a type that has since been deactivated', async () => {
    renderPage();
    await openMenu('events.type');
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Baptism' }));

    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'baptism' }),
    ));
  });

  it('keeps the sort when the type filter changes, and vice versa', async () => {
    renderPage();
    await openMenu('events.event');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'A – Z' }));
    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'event_name', sortOrder: 'asc' }),
    ));

    await openMenu('events.type');
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Wedding' }));

    // Both, not one replacing the other — the params share one URL.
    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'event_name', sortOrder: 'asc', type: 'wedding' }),
    ));
  });

  it('goes back to page 1 when the order changes', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
    ));

    await openMenu('events.expires');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Expiring soonest' }));

    // Page 2 of "newest first" is a different set of galleries than page 2 of
    // the previous order, so staying on it would silently skip rows.
    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, sortBy: 'expires_at', sortOrder: 'asc' }),
    ));
  });

  it('marks the applied option, and only on the column that owns it', async () => {
    renderPage();
    await openMenu('events.date');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Newest first' }));

    await openMenu('events.date');
    expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Oldest first' })).toHaveAttribute('aria-checked', 'false');

    await userEvent.keyboard('{Escape}');
    await openMenu('events.event');
    for (const name of ['A – Z', 'Z – A']) {
      expect(screen.getByRole('menuitemradio', { name })).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('restores a sort from the URL, so a reload or a pasted link keeps the view', async () => {
    renderPage('/admin/events?sort=photo_count&dir=asc&type=wedding');
    await waitFor(() => expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'photo_count', sortOrder: 'asc', type: 'wedding' }),
    ));

    await openMenu('Photos');
    expect(screen.getByRole('menuitemradio', { name: 'Fewest photos' })).toHaveAttribute('aria-checked', 'true');
  });

  it('ignores half a sort pair rather than ordering by something no header shows', async () => {
    // A link that lost its &dir=, or a hand-edited key the menus never produce.
    // Forwarding either would sort the table while every header still rendered
    // as unsorted and no menu item carried a check.
    renderPage('/admin/events?sort=event_name');
    await waitFor(() => expect(getEvents).toHaveBeenCalled());
    expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: undefined, sortOrder: undefined }),
    );

    getEvents.mockClear();
    renderPage('/admin/events?sort=drop_table&dir=asc');
    await waitFor(() => expect(getEvents).toHaveBeenCalled());
    expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: undefined, sortOrder: undefined }),
    );
  });

  it('moves between options with the arrow keys, as role=menu promises', async () => {
    renderPage();
    await openMenu('events.date');

    // Opening focuses the first option, so arrow keys have a starting point.
    expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Oldest first' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('menuitemradio', { name: 'First created' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitemradio', { name: 'First created' })).toHaveFocus();
  });

  it('keeps the visible column name as the trigger\'s accessible name', async () => {
    // An aria-label naming the action would replace it, so "click Datum" would
    // match nothing by voice and the column would never be read out (WCAG 2.5.3).
    renderPage();
    expect(await screen.findByRole('button', { name: 'events.date' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'events.event' })).toBeInTheDocument();
  });

  it('closes on Escape without applying anything, and hands focus back', async () => {
    renderPage();
    await waitFor(() => expect(getEvents).toHaveBeenCalled());
    const before = getEvents.mock.calls.length;

    const trigger = await screen.findByRole('button', { name: 'events.date' });
    await openMenu('events.date');
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menuitemradio', { name: 'Newest first' })).not.toBeInTheDocument();
    expect(getEvents).toHaveBeenCalledTimes(before);
    // Focus must come back to the header, or a keyboard user is dropped at the
    // top of the document with no idea where they were.
    expect(trigger).toHaveFocus();
  });

  it('caps the menu height and lets it scroll, rather than running off-screen', async () => {
    // The type menu is one row per configured type, so the list is open-ended.
    renderPage();
    await openMenu('events.date');
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('overflow-y-auto');
    expect(menu.style.maxHeight).toMatch(/^\d+px$/);
  });

  it('closes on a page scroll, including one whose target is not a Node', async () => {
    // Node.contains() throws on a non-Node argument rather than returning
    // false, so a scroll event targeting the Window threw inside the handler
    // and left the menu open for good.
    renderPage();
    await openMenu('events.date');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    window.dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('stays open when the scrolling happened inside the menu itself', async () => {
    // Arrowing onto an option below the fold scrolls it into view — a scroll
    // event — which must not be read as the page moving under the menu.
    renderPage();
    await openMenu('events.date');
    const menu = screen.getByRole('menu');

    menu.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes when focus leaves it by Tab', async () => {
    renderPage();
    await openMenu('events.date');
    const menu = screen.getByRole('menu');

    menu.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('offers no type menu until the catalogue has loaded', async () => {
    // An empty catalogue would leave a menu whose only entry is "All types",
    // which filters nothing — the header says so by not opening.
    const { eventTypesService } = await import('../../../services/eventTypes.service');
    vi.mocked(eventTypesService.getEventTypes).mockReturnValueOnce(new Promise(() => {}));

    renderPage();
    const trigger = await screen.findByRole('button', { name: 'events.type' });
    expect(trigger).toBeDisabled();
    await userEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
