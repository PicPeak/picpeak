import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { formatMoneyMinor } from '../../../utils/money';

const { getEventOverview } = vi.hoisted(() => ({ getEventOverview: vi.fn() }));
vi.mock('../../../services/customer.service', () => ({ customerService: { getEventOverview } }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../contexts/CustomerAuthContext', () => ({ useCustomerAuth: () => ({ customer: null }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: (value: string) => value, formatExpiry: (value: string) => value }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback || _key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { CustomerEventPage } from '../CustomerEventPage';

const event = { id: 7, slug: 'wedding', eventName: 'Wedding', eventType: 'wedding', eventDate: null,
  expiresAt: null, isActive: true, assignedAt: null, availability: 'active' };

describe('customer event page amounts', () => {
  it('shows quote and invoice totals that arrive as PostgreSQL bigint strings', async () => {
    getEventOverview.mockResolvedValue({
      event, sections: { quotes: true, invoices: true },
      quotes: [{ id: 1, quoteNumber: 'Q-1', status: 'sent', issueDate: null, totalAmountMinor: '123450', currency: 'CHF' }],
      contracts: [],
      invoices: [{ id: 2, invoiceNumber: 'R-1', status: 'sent', dueDate: null, totalAmountMinor: '98765', currency: 'CHF' }],
      documents: [],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/customer/events/wedding']}>
      <Routes><Route path="/customer/events/:slug" element={<CustomerEventPage />} /></Routes>
    </MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText('Q-1')).toBeInTheDocument();
    const quoteTotal = formatMoneyMinor(123450, 'CHF');
    const invoiceTotal = formatMoneyMinor(98765, 'CHF');
    expect(screen.getByText((_, el) => el?.tagName === 'P' && !!el.textContent?.includes(quoteTotal))).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && !!el.textContent?.includes(invoiceTotal))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(formatMoneyMinor(0, 'CHF'));
  });
});
