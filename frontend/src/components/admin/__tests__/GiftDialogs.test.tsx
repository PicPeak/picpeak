/**
 * Add stock (migration 343): the supplier invoice field follows the same gate
 * as the document it opens, and picking one suggests the cost without locking it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const flags = { incomingInvoices: true };
const permissions = new Set(['accounting.view', 'accounting.manage']);
const addStock = vi.fn().mockResolvedValue({});
const listInbound = vi.fn();

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
        const text = typeof fallback === 'string' ? fallback : '';
        return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags }) }));
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasPermission: (name: string) => permissions.has(name) }),
}));
vi.mock('../../../services/gifts.service', () => ({
  giftsService: { addStock: (...args: unknown[]) => addStock(...args) },
}));
vi.mock('../../../services/accounting.service', () => ({
  accountingService: { listInbound: (...args: unknown[]) => listInbound(...args), uploadInbound: vi.fn() },
}));
vi.mock('../../common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common')>();
  return { ...actual, LocalizedDateInput: () => null };
});

import { AddStockModal } from '../GiftDialogs';

const item = { id: 7, name: 'Wine', description: null, isArchived: false, stock: 2 };

const renderModal = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AddStockModal item={item} onClose={() => {}} />
  </QueryClientProvider>,
);

beforeEach(() => {
  addStock.mockClear();
  listInbound.mockReset();
  listInbound.mockResolvedValue({
    items: [{ id: 3, supplierName: 'Wine shop', invoiceNumber: 'R-1', invoiceDate: '2026-10-01', netAmountMinor: 12000, currency: 'EUR' }],
  });
  flags.incomingInvoices = true;
  permissions.clear();
  permissions.add('accounting.view');
  permissions.add('accounting.manage');
});

describe('AddStockModal', () => {
  it('hides the invoice field without incoming invoices or accounting access', async () => {
    flags.incomingInvoices = false;
    renderModal();
    expect(screen.queryByLabelText('Supplier invoice (optional)')).toBeNull();
    expect(listInbound).not.toHaveBeenCalled();
  });

  it('offers no upload to an admin who can only read accounting', async () => {
    permissions.delete('accounting.manage');
    renderModal();
    await screen.findByText(/Wine shop/);
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('adds stock with a linked invoice and its currency', async () => {
    renderModal();
    await screen.findByText(/Wine shop/);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Supplier invoice (optional)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add stock' }));
    await waitFor(() => expect(addStock).toHaveBeenCalled());
    expect(addStock.mock.calls[0][0]).toBe(7);
    expect(addStock.mock.calls[0][1]).toMatchObject({
      quantity: 6, unitCostMinor: 2000, currency: 'EUR', inboundDocumentId: 3, occurredOn: '2026-10-01',
    });
  });
});
