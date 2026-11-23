/**
 * The invoices list asks the server for 25 rows a page. It used to render no
 * pager, so every invoice after the first 25 was out of reach. Pins that the
 * Previous/Next footer shows when there is more than one page, that Next
 * requests page 2, and that ticking Unpaid only goes back to page 1.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = typeof fb === 'string' ? fb : k;
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        return vars ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? '')) : base;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => String(d) }),
}));

const list = vi.fn();
vi.mock('../../../../services/bills.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/bills.service')>('../../../../services/bills.service');
  return { ...actual, billsService: { list: (...args: unknown[]) => list(...args) } };
});

import { BillsListPage } from '../BillsListPage';

function invoice(id: number) {
  return {
    id, invoiceNumber: `R-2026-${String(id).padStart(4, '0')}`, kind: 'invoice', status: 'sent', currency: 'CHF',
    customerAccountId: 3,
    customer: { email: 'anna@example.com', displayName: 'Anna Muster', companyName: null },
    issueDate: '2026-10-08', dueDate: '2026-11-07', totalAmountMinor: 100000,
    installmentIndex: 0, installmentTotal: 1,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><BillsListPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BillsListPage pager', () => {
  beforeEach(() => list.mockReset());

  it('shows Previous/Next past 25 invoices and Next loads page 2', async () => {
    list.mockImplementation(({ page = 1 }: { page?: number } = {}) => Promise.resolve({
      invoices: [invoice(page)],
      pagination: { total: 30, page, pageSize: 25, totalPages: 2 },
    }));
    renderPage();

    expect(await screen.findByText('Page 1 of 2 · 30 invoices')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Page 2 of 2 · 30 invoices')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 25 }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('goes back to page 1 when Unpaid only is ticked', async () => {
    list.mockImplementation(({ page = 1 }: { page?: number } = {}) => Promise.resolve({
      invoices: [invoice(page)],
      pagination: { total: 30, page, pageSize: 25, totalPages: 2 },
    }));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 2 · 30 invoices')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ unpaidOnly: true, page: 1 })));
  });

  it('renders no pager for a single page', async () => {
    list.mockResolvedValue({
      invoices: [invoice(1)],
      pagination: { total: 1, page: 1, pageSize: 25, totalPages: 1 },
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('R-2026-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });
});
