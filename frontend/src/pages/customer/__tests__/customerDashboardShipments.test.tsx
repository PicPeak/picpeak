/**
 * Customer dashboard → Shipments (issue 2422): the parcels of the customer's
 * album orders, with a tracking link that opens the carrier in a new tab.
 * The card is absent when there are none.
 */
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { CustomerDashboard } from '../../../services/customer.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: unknown, opts?: Record<string, unknown>) =>
      typeof fb === 'string' ? fb.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts?.[key] ?? '')) : _k,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => String(d).slice(0, 10), formatExpiry: (d: string) => String(d) }),
}));

const state = vi.hoisted(() => ({ dashboard: null as unknown as CustomerDashboard }));
vi.mock('../../../services/customer.service', () => ({
  customerService: { getDashboard: vi.fn(async () => state.dashboard) },
}));

import { CustomerDashboardPage } from '../CustomerDashboardPage';

const base: CustomerDashboard = {
  needsAction: { quotes: [], contracts: [], invoices: [] },
  recent: [],
  galleries: { active: [], expired: [] },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><CustomerDashboardPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('dashboard shipments', () => {
  beforeEach(() => { state.dashboard = base; });

  it('lists each parcel with its album, carrier and an external tracking link', async () => {
    state.dashboard = {
      ...base,
      shipments: [
        { id: 2, carrier: 'dhl', carrierName: 'DHL', trackingNumber: '00340434', trackingUrl: 'https://www.dhl.de/x?piececode=00340434', shippedAt: '2026-11-05T10:00:00.000Z', productName: 'Fine Art Album', eventName: 'Wedding' },
        { id: 1, carrier: 'other', carrierName: null, trackingNumber: 'AB-1', trackingUrl: null, shippedAt: '2026-11-01T10:00:00.000Z', productName: 'Parents album', eventName: 'Wedding' },
      ],
    };
    renderPage();
    const card = (await screen.findByRole('heading', { name: 'Shipments' })).closest('section') as HTMLElement;
    const items = within(card).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Fine Art Album · Wedding');
    expect(items[0]).toHaveTextContent('DHL · 00340434 · sent 2026-11-05');
    const link = within(items[0]).getByRole('link', { name: /Track parcel/ });
    expect(link).toHaveAttribute('href', 'https://www.dhl.de/x?piececode=00340434');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // A typed-in carrier without a link shows the number, no link.
    expect(items[1]).toHaveTextContent('Parcel · AB-1');
    expect(within(items[1]).queryByRole('link')).toBeNull();
  });

  it('shows no card without shipments', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Your galleries' });
    expect(screen.queryByRole('heading', { name: 'Shipments' })).toBeNull();
  });
});
