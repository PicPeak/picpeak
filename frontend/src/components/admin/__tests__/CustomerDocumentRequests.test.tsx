/**
 * Admin → customer record → "Requested from the customer" (#1444 slice 10).
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toastMock }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => String(d).slice(0, 10), formatDateTime: (d: string) => d }),
}));

const svc = vi.hoisted(() => ({
  listRequests: vi.fn(async () => [
    {
      id: 3, title: 'Signed contract', note: 'Page 3', dueAt: null, status: 'open', eventId: null, contractId: null,
      fulfilledDocumentId: null, fulfilledAt: null, cancelledAt: null, reminderCount: 1, remindedAt: null,
      createdAt: '2026-09-20T10:00:00Z',
    },
    {
      id: 2, title: 'ID copy', note: null, dueAt: null, status: 'fulfilled', eventId: null, contractId: null,
      fulfilledDocumentId: 9, fulfilledAt: '2026-09-19T10:00:00Z', cancelledAt: null, reminderCount: 0, remindedAt: null,
      createdAt: '2026-09-18T10:00:00Z',
    },
  ]),
  createRequest: vi.fn(async () => ({ request: { id: 4 }, notification: 'queued' })),
  cancelRequest: vi.fn(async () => undefined),
}));
vi.mock('../../../services/customerDocumentsAdmin.service', () => ({ customerDocumentsAdminService: svc }));

import { CustomerDocumentRequests } from '../CustomerDocumentRequests';

function renderIt(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={qc}><CustomerDocumentRequests customerId={5} canManage /></QueryClientProvider>);
}

describe('CustomerDocumentRequests', () => {
  it('lists requests with their status and lets only an open one be cancelled', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderIt(qc);
    expect(await screen.findByText('Signed contract')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText(/1 reminder\(s\) sent/)).toBeInTheDocument();
    const cancels = screen.getAllByRole('button', { name: 'Cancel request' });
    expect(cancels).toHaveLength(1);
    await userEvent.click(cancels[0]);
    await waitFor(() => expect(svc.cancelRequest).toHaveBeenCalledWith(5, 3));
    // The cancel is logged; the activity card refreshes with the list.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin-customer-activity', 5] }));
  });

  it('creates a request and says the customer is emailed', async () => {
    renderIt();
    await screen.findByText('Signed contract');
    const create = screen.getByRole('button', { name: 'Request document' });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText('What do you need?'), 'Passport copy');
    await userEvent.type(screen.getByLabelText('Note for the customer (optional)'), 'Both sides');
    await userEvent.click(create);
    await waitFor(() => expect(svc.createRequest).toHaveBeenCalledWith(5, {
      title: 'Passport copy', note: 'Both sides', dueAt: null,
    }));
    expect(toastMock.success).toHaveBeenCalledWith('Request sent. The customer gets an email.');
  });

  it('sends the chosen deadline as that calendar day, whatever the admin\'s timezone', async () => {
    renderIt();
    await screen.findByText('Signed contract');
    await userEvent.type(screen.getByLabelText('What do you need?'), 'Passport copy');
    fireEvent.change(screen.getByLabelText('Needed by (optional)'), { target: { value: '2026-09-22' } });
    await userEvent.click(screen.getByRole('button', { name: 'Request document' }));
    await waitFor(() => expect(svc.createRequest).toHaveBeenCalledWith(5, expect.objectContaining({
      dueAt: '2026-09-22T12:00:00.000Z',
    })));
  });
});
