/**
 * Customer dashboard → Recent and the document items in Needs action (#1444
 * slice 6). The server decides what is visible; the page must label every
 * kind in words and link each item to where it lives.
 */
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
        const found = lookup(k);
        const base = typeof found === 'string' ? found : (typeof fb === 'string' ? `MISSING:${k}` : k);
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
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
  },
  recent: [
    { kind: 'document_shared', id: 3, title: 'offer.pdf', at: '2026-09-20T10:00:00Z', link: '/customer/documents/3' },
    { kind: 'document_rejected', id: 7, title: 'passport-scan.pdf', at: '2026-09-19T10:00:00Z', link: '/customer/documents/7' },
    { kind: 'contract_sent', id: 2, title: 'C-2026-0002', at: '2026-09-18T10:00:00Z', link: '/customer/contracts' },
    { kind: 'gallery_assigned', id: 9, title: 'Wedding', at: '2026-09-17T10:00:00Z', link: '/customer/events/wedding' },
  ],
  galleries: { active: [], expired: [] },
};

vi.mock('../../../services/customer.service', () => ({
  customerService: { getDashboard: vi.fn(async () => dashboard) },
}));

import { CustomerDashboardPage } from '../CustomerDashboardPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><CustomerDashboardPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CustomerDashboardPage — Recent', () => {
  it('labels each recent item in words and links it to where it lives', async () => {
    renderPage();
    const recent = await screen.findByRole('region', { name: 'Recent' });
    const links = within(recent).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['New document: offer.pdf', '/customer/documents/3'],
      ['passport-scan.pdf was not accepted', '/customer/documents/7'],
      ['Contract C-2026-0002 was sent to you', '/customer/contracts'],
      ['Gallery Wedding is now available to you', '/customer/events/wedding'],
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
});
