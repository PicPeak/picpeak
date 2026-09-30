/**
 * /admin/events counted every row as a photo: an event with forty clips read
 * "40" under "Photos" (issue 1430). The count column now shows the split for an
 * event that holds videos, and the column and the totals card say "media" once
 * the install holds any. Without videos nothing on the page changes.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      // Interpolates {{count}} so the split label reads as it does on screen.
      t: (k: string, fb?: unknown, opts?: { count?: number }) => {
        const text = typeof fb === 'string' ? fb : k;
        return opts?.count === undefined ? text : text.replace('{{count}}', String(opts.count));
      },
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
  eventTypesService: { getEventTypes: vi.fn().mockResolvedValue([]) },
}));

const getDashboardStats = vi.fn();
vi.mock('../../../services/admin.service', () => ({
  adminService: { getDashboardStats: (...args: unknown[]) => getDashboardStats(...args) },
}));

import { EventsListPage } from '../EventsListPage';

const event = (id: number, event_name: string, photo_count: number, video_count?: number) => ({
  id,
  slug: `slug-${id}`,
  event_name,
  event_type: 'wedding',
  event_date: '2026-08-01',
  customer_email: 'k@example.com',
  expires_at: '2026-12-01T00:00:00.000Z',
  photo_count,
  video_count,
  is_active: true,
  is_archived: false,
  is_draft: false,
  require_password: true,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/events']}>
        <EventsListPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr')!;

describe('events list media counts', () => {
  beforeEach(() => {
    getEvents.mockReset();
    getDashboardStats.mockReset();
  });

  it('shows the split under the count for an event that holds videos, and only there', async () => {
    getEvents.mockResolvedValue({
      events: [event(1, 'Hybrid Wedding', 143, 6), event(2, 'Photo Shoot', 12, 0)],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
    });
    getDashboardStats.mockResolvedValue({ totalEvents: 2, totalPhotos: 155, totalVideos: 6 });
    renderPage();

    expect(within(await rowOf('Hybrid Wedding')).getByText('137 photos · 6 videos')).toBeInTheDocument();
    expect(within(await rowOf('Photo Shoot')).queryByText(/videos/)).not.toBeInTheDocument();

    // The install holds videos: the column and the totals card say so.
    expect(await screen.findByRole('button', { name: 'Media' })).toBeInTheDocument();
    expect(screen.getByText('Total Media')).toBeInTheDocument();
    expect(screen.getByText('149 photos · 6 videos')).toBeInTheDocument();
  });

  it('changes nothing on an install without videos', async () => {
    getEvents.mockResolvedValue({
      events: [event(2, 'Photo Shoot', 12, 0)],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    getDashboardStats.mockResolvedValue({ totalEvents: 1, totalPhotos: 12, totalVideos: 0 });
    renderPage();

    await rowOf('Photo Shoot');
    expect(await screen.findByRole('button', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByText('events.stats.totalPhotos')).toBeInTheDocument();
    expect(screen.queryByText('Total Media')).not.toBeInTheDocument();
    expect(screen.queryByText(/videos/)).not.toBeInTheDocument();
  });
});
