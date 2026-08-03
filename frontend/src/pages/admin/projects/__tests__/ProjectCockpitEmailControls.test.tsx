/**
 * The cockpit's email feed used to render preview/resend/cancel/retry/send-now
 * for every mail, consulting neither the caller's role nor their permissions.
 * Two ways that produced dead controls (#969):
 *
 *   404 — requireOwnedQueuedEmail scopes queued mail through
 *         email_queue.event_id. CRM document mail (quote/contract/invoice/
 *         storno) is queued with event_id = null, so for a non-super_admin it
 *         has no ownable parent and always 404s. Introduced by the GHSA-93x4
 *         fix in #960/#966, which added the ownership middleware.
 *   403 — preview requires `events.view` but the four write actions require
 *         `email.send`; the feed rendered all of them regardless.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
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

// An event mail (actionable by anyone who owns the event) and a CRM document
// mail (event_id null → only a super_admin can act on it). Both 'sent', so the
// Resend button is the one under test in each row.
const OVERVIEW = {
  project: {
    id: 1, name: 'Hochzeit Müller', customerAccountId: 1,
    customerEmail: 'kunde@example.com', status: 'active',
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  },
  events: [], quotes: [], contracts: [], invoices: [],
  hours: { entries: [], totalMinutes: 0 },
  milestones: [],
  valuation: { byCurrency: [] },
  emails: [
    { id: 11, recipient: 'kunde@example.com', type: 'gallery_ready', status: 'sent',
      queuedAt: '2026-08-01T10:00:00Z', sentAt: '2026-08-01T10:00:05Z', error: null,
      eventId: 42, stored: true },
    { id: 12, recipient: 'kunde@example.com', type: 'invoice_sent', status: 'sent',
      queuedAt: '2026-08-01T11:00:00Z', sentAt: '2026-08-01T11:00:05Z', error: null,
      eventId: null, stored: true },
  ],
};

vi.mock('../../../../services/projects.service', () => ({
  projectsService: {
    overview: vi.fn(async () => OVERVIEW),
    emailPreview: vi.fn(async () => ({ html: '<p>x</p>', subject: 's' })),
    resendEmail: vi.fn(), cancelEmail: vi.fn(), retryEmail: vi.fn(), sendEmailNow: vi.fn(),
    update: vi.fn(), assignEvent: vi.fn(),
  },
}));

vi.mock('../../../../services/events.service', () => ({
  eventsService: { getEvents: vi.fn(async () => []) },
}));

vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { projects: true, quotes: true, contracts: true, bills: true } }),
}));

let mockPerms = { isSuperAdmin: false, permissions: ['events.view'] };
vi.mock('../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    isSuperAdmin: mockPerms.isSuperAdmin,
    hasPermission: (p: string) => mockPerms.isSuperAdmin || mockPerms.permissions.includes(p),
  }),
}));

import { ProjectCockpitPage } from '../ProjectCockpitPage';

const renderPage = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/projects/1']}>
        <Routes>
          <Route path="/admin/projects/:id" element={<ProjectCockpitPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getAllByText(/Email/).length).toBeGreaterThan(0));
};

describe('ProjectCockpitPage email controls (#969)', () => {
  beforeEach(() => { mockPerms = { isSuperAdmin: false, permissions: ['events.view'] }; });

  it('super_admin sees controls on both event and CRM document mail', async () => {
    mockPerms = { isSuperAdmin: true, permissions: [] };
    await renderPage();
    // Preview on both rows, Resend on both (super_admin implies email.send).
    expect(screen.getAllByText('Preview')).toHaveLength(2);
    expect(screen.getAllByText('Resend')).toHaveLength(2);
  });

  it('a scoped admin gets no controls on CRM document mail (would 404)', async () => {
    mockPerms = { isSuperAdmin: false, permissions: ['events.view', 'email.send'] };
    await renderPage();
    // Only the event-linked mail is actionable; the CRM row offers nothing.
    expect(screen.getAllByText('Preview')).toHaveLength(1);
    expect(screen.getAllByText('Resend')).toHaveLength(1);
  });

  it('an admin without email.send sees preview but no write actions (would 403)', async () => {
    mockPerms = { isSuperAdmin: false, permissions: ['events.view'] };
    await renderPage();
    expect(screen.getAllByText('Preview')).toHaveLength(1);
    expect(screen.queryByText('Resend')).toBeNull();
    expect(screen.queryByText('Cancel')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('Send now')).toBeNull();
  });
});
