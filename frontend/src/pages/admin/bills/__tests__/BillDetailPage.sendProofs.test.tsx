/**
 * A scheduled invoice is edited on its own page, so Send can run with unsaved
 * edits. When the invoice re-bills supplier invoices, Send opens the proof
 * dialog first — and the dialog's send has to save the edits before the
 * invoice goes out, and send nothing when that save fails. Otherwise the
 * stale invoice is issued and the edits are lost behind an issued document.
 */
import React, { forwardRef, useEffect, useImperativeHandle } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConfirmDialogProvider } from '../../../../components/common/ConfirmDialog';

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
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../../components/admin/DocumentLineageCard', () => ({ DocumentLineageCard: () => null }));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { incomingInvoices: true, bills: true }, isLoading: false }),
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => String(d), formatDateTime: (d: string) => String(d), formatTime: (d: string) => String(d) }),
}));

// The form: dirty from the start, with a save the test controls.
const save = vi.fn();
vi.mock('../BillEditorPage', () => ({
  BillForm: forwardRef((props: { onStateChange?: (s: unknown) => void }, ref) => {
    useImperativeHandle(ref, () => ({ save, discard: vi.fn(), previewUnsaved: vi.fn() }));
    const { onStateChange } = props;
    useEffect(() => { onStateChange?.({ dirty: true, busy: false, valid: true, spawnCount: 0 }); }, [onStateChange]);
    return <div>Bill form</div>;
  }),
}));

const send = vi.fn();
vi.mock('../../../../services/bills.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/bills.service')>('../../../../services/bills.service');
  return {
    ...actual,
    billsService: {
      get: () => Promise.resolve({ invoice, lineItems: [], payments: [] }),
      send: (...args: unknown[]) => send(...args),
    },
  };
});
vi.mock('../../../../services/accounting.service', () => ({
  accountingService: {
    getInvoiceRebillProofs: () => Promise.resolve({
      proofs: [{ id: 5, hasProof: true, supplierName: 'Print AG', invoiceNumber: 'P-1', totalMinor: 12000, currency: 'CHF' }],
      attachDefault: true,
    }),
  },
}));

const invoice = {
  id: 1, invoiceNumber: 'R-2026-0001', kind: 'invoice', status: 'scheduled', currency: 'CHF',
  customerAccountId: 3,
  customer: { email: 'anna@example.com', displayName: 'Anna Muster', companyName: null, isPassive: false },
  issueDate: '2026-10-08', dueDate: '2026-11-07', scheduledSendAt: null,
  netAmountMinor: 100000, vatRate: 0, vatAmountMinor: 0, shippingAmountMinor: 0, totalAmountMinor: 100000,
  paidAmountMinor: 0, payments: [], lineItems: [],
};

import { BillDetailPage } from '../BillDetailPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={['/admin/clients/bills/1']}>
          <Routes>
            <Route path="/admin/clients/bills/:id" element={<BillDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
}

async function openProofDialogAndSend() {
  await userEvent.click(await screen.findByRole('button', { name: /^Send$|Send invoice|Send now/i }));
  await userEvent.click(await screen.findByRole('button', { name: /Send with 1 proof/i }));
}

describe('BillDetailPage — send with supplier proofs', () => {
  beforeEach(() => { save.mockReset(); send.mockReset(); });

  it('saves the unsaved edits before the invoice goes out', async () => {
    save.mockResolvedValue(1);
    send.mockResolvedValue({});
    renderPage();
    await openProofDialogAndSend();
    await waitFor(() => expect(send).toHaveBeenCalledWith(1, [5]));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it('sends nothing when the save fails', async () => {
    save.mockResolvedValue(null);
    renderPage();
    await openProofDialogAndSend();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(send).not.toHaveBeenCalled();
  });
});
