/**
 * Customer dashboard → Recent and the document items in Needs action (#1444
 * slice 6), and the activity page with the whole feed. The server decides
 * what is visible; the pages must label every kind in words and link each
 * item to where it lives. The dashboard shows the newest three.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { CustomerDashboard } from '../../../services/customer.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        const count = vars?.count;
        const found = typeof count === 'number' ? lookup(`${k}_${count === 1 ? 'one' : 'other'}`) : lookup(k);
        const base = typeof found === 'string' ? found : (typeof fb === 'string' ? `MISSING:${k}` : k);
        return vars ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? '')) : base;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => String(d).slice(0, 10), formatDateTime: (d: string) => String(d) }),
}));

const dashboard: CustomerDashboard = {
  needsAction: {
    quotes: [], contracts: [], invoices: [],
    documents: [{ id: 7, name: 'passport-scan.pdf', reviewNote: 'Too blurry' }],
    documentRequests: [{ id: 2, title: 'Signed contract', note: null, dueAt: null, link: '/customer/documents?request=2' }],
    contractDetails: [{ id: 4, contractNumber: 'C-2026-0004', title: null, eventName: null, validUntil: null, sentAt: null }],
  },
  recent: [
    { kind: 'document_shared', id: 3, title: 'offer.pdf', at: '2026-09-20T10:00:00Z', link: '/customer/documents/3' },
    { kind: 'document_rejected', id: 7, title: 'passport-scan.pdf', at: '2026-09-19T10:00:00Z', link: '/customer/documents/7' },
    { kind: 'contract_sent', id: 2, title: 'C-2026-0002', at: '2026-09-18T10:00:00Z', link: '/customer/contracts' },
    { kind: 'gallery_assigned', id: 9, title: 'Wedding', at: '2026-09-17T10:00:00Z', link: '/customer/events/wedding' },
    { kind: 'photos_added', id: '9-2026-09-16', title: 'Wedding', at: '2026-09-16T10:00:00Z', link: '/customer/events/wedding', counts: { photos: 12, videos: 2 } },
    { kind: 'photos_added', id: '9-2026-09-15', title: 'Wedding', at: '2026-09-15T10:00:00Z', link: '/customer/events/wedding', counts: { photos: 1, videos: 0 } },
    { kind: 'photos_added', id: '9-2026-09-14', title: 'Wedding', at: '2026-09-14T10:00:00Z', link: '/customer/events/wedding', counts: { photos: 0, videos: 3 } },
    { kind: 'photos_added', id: '9-2026-09-13', title: 'Wedding', at: '2026-09-13T10:00:00Z', link: '/customer/events/wedding', counts: { photos: 40, videos: 1 } },
  ],
  galleries: { active: [], expired: [] },
};

vi.mock('../../../services/customer.service', () => ({
  customerService: {
    getDashboard: vi.fn(async () => dashboard),
    getActivity: vi.fn(async () => dashboard.recent),
  },
}));

import { CustomerDashboardPage } from '../CustomerDashboardPage';
import { CustomerActivityPage } from '../CustomerActivityPage';

function renderPage(page: React.ReactElement = <CustomerDashboardPage />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CustomerDashboardPage — Recent', () => {
  it('shows the newest three and links to the activity page for the rest', async () => {
    renderPage();
    const recent = await screen.findByRole('region', { name: 'Recent' });
    const links = within(recent).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['New document: offer.pdf', '/customer/documents/3'],
      ['passport-scan.pdf was not accepted', '/customer/documents/7'],
      ['Contract C-2026-0002 was sent to you', '/customer/contracts'],
      ['Show all activity', '/customer/activity'],
    ]);
  });

  it('labels each item on the activity page in words and links it to where it lives', async () => {
    renderPage(<CustomerActivityPage />);
    await screen.findByRole('link', { name: 'New document: offer.pdf' });
    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href') !== '/customer/dashboard');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['New document: offer.pdf', '/customer/documents/3'],
      ['passport-scan.pdf was not accepted', '/customer/documents/7'],
      ['Contract C-2026-0002 was sent to you', '/customer/contracts'],
      ['Gallery Wedding is now available to you', '/customer/events/wedding'],
      ['12 new photos and 2 videos in Wedding', '/customer/events/wedding'],
      ['1 new photo in Wedding', '/customer/events/wedding'],
      ['3 new videos in Wedding', '/customer/events/wedding'],
      ['40 new photos and 1 video in Wedding', '/customer/events/wedding'],
    ]);
    expect(screen.queryByText(/MISSING:/)).toBeNull();
  });

  it('puts a rejected upload under Needs your attention with its note', async () => {
    renderPage();
    const needs = await screen.findByRole('region', { name: 'Needs your attention' });
    expect(needs).toHaveTextContent('passport-scan.pdf was not accepted — upload a corrected version');
    expect(needs).toHaveTextContent('Too blurry');
    expect(within(needs).getByRole('link', { name: 'View document' })).toHaveAttribute('href', '/customer/documents/7');
  });

  it('lists a document the photographer asked for, linking to the upload with it preselected', async () => {
    renderPage();
    const needs = await screen.findByRole('region', { name: 'Needs your attention' });
    expect(needs).toHaveTextContent('Please upload: Signed contract');
    expect(within(needs).getByRole('link', { name: 'Upload' })).toHaveAttribute('href', '/customer/documents?request=2');
  });

  it('tells a customer with an awaiting_data contract to complete their details (#1590)', async () => {
    renderPage();
    const needs = await screen.findByRole('region', { name: 'Needs your attention' });
    expect(needs).toHaveTextContent('Complete your details for contract C-2026-0004');
    expect(within(needs).getByRole('link', { name: 'Complete my details' })).toHaveAttribute('href', '/customer/contracts');
  });
});
