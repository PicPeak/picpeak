/**
 * The cockpit feed orders its rows by the same reading of the date it prints
 * (issue 1815).
 *
 * A queued mail carries `email_queue.created_at`, which on a SQLite install
 * is the database default: a zone-less 'YYYY-MM-DD HH:MM:SS' in UTC. The row
 * prints it through useLocalizedDate, which reads that shape as UTC, while
 * the sort read it with `new Date`, as local time. West of UTC a mail queued
 * at 12:00 UTC then sorted above one sent at 12:30 UTC while showing the
 * earlier clock time.
 *
 * Run under TZ=America/New_York and TZ=Europe/Berlin; the order asserted is
 * the order of the instants, so it holds in every zone.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mail = (id: number, recipient: string, queuedAt: string | number, sentAt: string | null) => ({
  id, recipient, type: 'gallery_ready', status: sentAt ? 'sent' : 'pending',
  queuedAt, sentAt, error: null, eventId: 42, stored: true, canAct: false,
});

let mockEmails: ReturnType<typeof mail>[] = [];

vi.mock('../../../../services/projects.service', () => ({
  projectsService: {
    overview: vi.fn(async () => ({
      project: {
        id: 1, name: 'Hochzeit Müller', customerAccountId: 1,
        customerEmail: 'kunde@example.com', status: 'active',
        createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
      },
      events: [], quotes: [], contracts: [], invoices: [],
      hours: { entries: [], totalMinutes: 0 },
      milestones: [],
      valuation: { byCurrency: [] },
      emails: mockEmails,
    })),
    emailPreview: vi.fn(), resendEmail: vi.fn(), cancelEmail: vi.fn(), retryEmail: vi.fn(),
    sendEmailNow: vi.fn(), update: vi.fn(), assignEvent: vi.fn(),
  },
}));

vi.mock('../../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_date_format: 'YYYY-MM-DD', general_time_format: '24h' } }),
}));

vi.mock('../../../../services/events.service', () => ({
  eventsService: { getEvents: vi.fn(async () => []) },
}));

vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { projects: true, quotes: true, contracts: true, bills: true } }),
}));

vi.mock('../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ isSuperAdmin: true, hasPermission: () => true }),
}));

import { ProjectCockpitPage } from '../ProjectCockpitPage';

/** The recipients of the feed rows, top to bottom. */
const feedOrder = async (emails: ReturnType<typeof mail>[]) => {
  mockEmails = emails;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/projects/1']}>
        <Routes>
          <Route path="/admin/projects/:id" element={<ProjectCockpitPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getAllByText(/@example\.com$/).length).toBe(emails.length));
  const order = screen.getAllByText(/@example\.com$/).map((node) => node.textContent);
  unmount();
  return order;
};

describe('ProjectCockpitPage feed order with a zone-less SQLite timestamp', () => {
  it('puts the newer mail first whichever way its date is spelled', async () => {
    const sent = mail(2, 'sent@example.com', '2026-10-05T12:29:00.000Z', '2026-10-05T12:30:00.000Z');
    // Still queued, so its date is the database-default created_at.
    expect(await feedOrder([mail(1, 'queued@example.com', '2026-10-05 12:00:00', null), sent]))
      .toEqual(['sent@example.com', 'queued@example.com']);
    // And queued a quarter of an hour after the other was sent: read as
    // local time east of UTC, it would sort hours before it.
    expect(await feedOrder([sent, mail(1, 'queued@example.com', '2026-10-05 12:45:00', null)]))
      .toEqual(['queued@example.com', 'sent@example.com']);
  });

  it('still orders a mail whose date is epoch milliseconds', async () => {
    // queueEmail writes created_at through knex as a Date, which SQLite keeps
    // as a number; the overview passes it on as it is.
    const sent = mail(2, 'sent@example.com', '2026-10-05T12:29:00.000Z', '2026-10-05T12:30:00.000Z');
    const queued = mail(1, 'queued@example.com', Date.parse('2026-10-05T12:45:00Z'), null);
    expect(await feedOrder([sent, queued])).toEqual(['queued@example.com', 'sent@example.com']);
  });
});
