/**
 * /admin/archives search, type filter and sort were applied client-side to
 * whatever 20-row page happened to be loaded (QA I.01), while the
 * pagination footer kept reporting the full server-side total. An archive on
 * page 7 was invisible to a search, with no hint the search was page-scoped.
 *
 * These pin the contract that fixes it: every control is a server query param,
 * and changing any of them goes back to page 1.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

const getArchives = vi.fn();
vi.mock('../../../services/archive.service', () => ({
  archiveService: {
    getArchives: (...args: unknown[]) => getArchives(...args),
    restoreArchive: vi.fn(),
    deleteArchive: vi.fn(),
    downloadArchive: vi.fn(),
    formatBytes: (b: number) => `${b} B`,
  },
}));

import { ArchivesPage } from '../ArchivesPage';

type Totals = { archives: number; photos: number; archiveSize: number };

const page = (archives: unknown[], total: number, totals?: Totals) => ({
  archives,
  pagination: { page: 1, limit: 20, total, totalPages: Math.ceil(total / 20) },
  // The aggregates are computed server-side over the filtered set; the page
  // only renders them.
  totals: totals ?? { archives: total, photos: total * 3, archiveSize: total * 100 },
});

const archive = (id: number, eventName: string, eventType = 'wedding') => ({
  id,
  slug: `slug-${id}`,
  eventName,
  eventDate: '2026-08-01',
  eventType,
  hostEmail: 'h@example.com',
  archivedAt: '2026-08-02T10:00:00.000Z',
  expiresAt: '2026-09-01T10:00:00.000Z',
  photoCount: 3,
  originalSize: 100,
  archiveSize: 100,
  archivePath: 'events/archived/x.zip',
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ArchivesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ArchivesPage server-side query (QA I.01)', () => {
  beforeEach(() => {
    getArchives.mockReset();
    getArchives.mockResolvedValue(page([archive(1, 'Alpha Wedding')], 802));
  });

  it('sends the search term to the server instead of filtering the loaded page', async () => {
    renderPage();
    const input = await screen.findByPlaceholderText('archives.searchPlaceholder');
    expect(getArchives).toHaveBeenLastCalledWith(1, 20, undefined, 'all', 'date');

    await userEvent.type(input, 'bravo');

    // Debounced — one request for the settled term, not one per keystroke.
    await waitFor(
      () => expect(getArchives).toHaveBeenLastCalledWith(1, 20, 'bravo', 'all', 'date'),
      { timeout: 2000 }
    );
  });

  it('sends the type filter and the sort key to the server', async () => {
    renderPage();
    await screen.findByDisplayValue('archives.allTypes');

    await userEvent.selectOptions(screen.getByDisplayValue('archives.allTypes'), 'birthday');
    await waitFor(() => expect(getArchives).toHaveBeenLastCalledWith(1, 20, undefined, 'birthday', 'date'));

    await userEvent.selectOptions(screen.getByDisplayValue('archives.sortByDate'), 'size');
    await waitFor(() => expect(getArchives).toHaveBeenLastCalledWith(1, 20, undefined, 'birthday', 'size'));
  });

  it('renders exactly the rows the server returned, unfiltered by the client', async () => {
    // A row the old client-side filter would have dropped: the server decided
    // it matches, so the page must show it.
    getArchives.mockResolvedValue(page([archive(2, 'Bravo Birthday', 'birthday')], 1));
    renderPage();
    expect(await screen.findByText('Bravo Birthday')).toBeInTheDocument();
  });

  it('goes back to page 1 when the query changes', async () => {
    renderPage();
    await userEvent.click(await screen.findByText('common.next'));
    await waitFor(() => expect(getArchives).toHaveBeenLastCalledWith(2, 20, undefined, 'all', 'date'));

    await userEvent.selectOptions(screen.getByDisplayValue('archives.allTypes'), 'corporate');
    await waitFor(() => expect(getArchives).toHaveBeenLastCalledWith(1, 20, undefined, 'corporate', 'date'));
  });

  it('reads the stat cards from the server totals, not from the loaded page', async () => {
    // One row on screen, 802 in the dataset. Summing the rendered rows — what
    // the cards used to do — would report 1 archive and 100 bytes.
    getArchives.mockResolvedValue(
      page([archive(1, 'Alpha Wedding')], 802, { archives: 802, photos: 12345, archiveSize: 999000 })
    );
    renderPage();

    expect(await screen.findByText('802')).toBeInTheDocument();
    // Grouped by the runtime's locale, so ask it rather than hardcoding.
    expect(screen.getByText((12345).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText('999000 B')).toBeInTheDocument();
    // Average is over the whole set too, not over the page.
    expect(screen.getByText(`${999000 / 802} B`)).toBeInTheDocument();
  });

  it('keeps the "showing X of Y" count on a single-page result', async () => {
    // The count used to live inside the `totalPages > 1` guard, so a search
    // that narrowed to one page hid the number that says how many matched.
    getArchives.mockResolvedValue(page([archive(1, 'Alpha Wedding')], 1));
    renderPage();

    expect(await screen.findByText('archives.showing')).toBeInTheDocument();
    // Page controls stay hidden — there is only one page.
    expect(screen.queryByText('common.next')).not.toBeInTheDocument();
  });

  it('shows no count at all when nothing matched', async () => {
    getArchives.mockResolvedValue(page([], 0));
    renderPage();

    expect(await screen.findByText('archives.noArchivesFound')).toBeInTheDocument();
    expect(screen.queryByText('archives.showing')).not.toBeInTheDocument();
  });
});
