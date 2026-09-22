/**
 * Customer portal → Documents → requests from the photographer (#1444 slice
 * 10). The request mail links to /customer/documents?request=<id>; that has
 * to preselect the request so the upload answers it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

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
  useLocalizedDate: () => ({
    // A Date as its local day, the way date-fns formats one.
    format: (d: string | Date) => (d instanceof Date
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : String(d).slice(0, 10)),
    formatDateTime: (d: string) => String(d),
  }),
}));

const { svc } = vi.hoisted(() => ({
  svc: {
    listDocuments: vi.fn(async () => ({
      documents: [], limits: { maxUploadBytes: 25 * 1024 * 1024, quotaBytes: 250 * 1024 * 1024, usedBytes: 0 },
    })),
    listEvents: vi.fn(async () => []),
    listDocumentRequests: vi.fn(async () => [
      { id: 4, title: 'Signed contract', note: 'All pages', dueAt: '2026-10-01T00:00:00Z', status: 'open', eventId: null, createdAt: null },
      { id: 5, title: 'ID copy', note: null, dueAt: null, status: 'open', eventId: null, createdAt: null },
    ]),
    uploadDocument: vi.fn(async () => ({ id: 1 })),
    downloadDocument: vi.fn(),
    deleteDocument: vi.fn(),
  },
}));
vi.mock('../../../services/customer.service', () => ({ customerService: svc }));

import { ConfirmDialogProvider } from '../../../components/common';
import { CustomerDocumentsPage } from '../CustomerDocumentsPage';

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={[path]}><CustomerDocumentsPage /></MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
}

const pdf = () => new File(['%PDF-1.4'], 'contract.pdf', { type: 'application/pdf' });

describe('CustomerDocumentsPage — document requests', () => {
  beforeEach(() => svc.uploadDocument.mockClear());

  it('lists what the photographer asked for, with note and due date', async () => {
    renderAt('/customer/documents');
    const region = await screen.findByRole('heading', { name: 'Requested by your photographer' });
    expect(region).toBeInTheDocument();
    expect(screen.getByText('Signed contract')).toBeInTheDocument();
    expect(screen.getByText('All pages')).toBeInTheDocument();
    expect(screen.getByText('Needed by 2026-10-01')).toBeInTheDocument();
    expect(screen.queryByText(/MISSING:/)).toBeNull();
  });

  it('preselects the request from the link in the mail and sends it with the upload', async () => {
    renderAt('/customer/documents?request=4');
    expect(await screen.findByText('This upload answers: Signed contract')).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('File'), pdf());
    await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
    await waitFor(() => expect(svc.uploadDocument).toHaveBeenCalledWith(
      expect.any(File), expect.objectContaining({ requestId: 4 }),
    ));
  });

  it('lets the customer pick a request, or upload without one', async () => {
    renderAt('/customer/documents');
    await userEvent.click(await screen.findByRole('button', { name: 'Upload a file for ID copy' }));
    expect(screen.getByText('This upload answers: ID copy')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Not for this request' }));
    expect(screen.queryByText(/This upload answers/)).toBeNull();
    await userEvent.upload(screen.getByLabelText('File'), pdf());
    await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
    await waitFor(() => expect(svc.uploadDocument).toHaveBeenCalledWith(
      expect.any(File), expect.objectContaining({ requestId: null }),
    ));
  });

  it('explains a request that is no longer open', async () => {
    svc.uploadDocument.mockRejectedValueOnce({ response: { status: 404, data: { code: 'DOCUMENT_REQUEST_NOT_FOUND' } } });
    renderAt('/customer/documents?request=4');
    await screen.findByText('This upload answers: Signed contract');
    await userEvent.upload(screen.getByLabelText('File'), pdf());
    await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
      'The request for contract.pdf is no longer open.',
    ));
  });

  it('still sends the linked request when the request list failed to load', async () => {
    svc.listDocumentRequests.mockRejectedValueOnce(new Error('network'));
    renderAt('/customer/documents?request=4');
    await userEvent.upload(await screen.findByLabelText('File'), pdf());
    await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
    await waitFor(() => expect(svc.uploadDocument).toHaveBeenCalledWith(
      expect.any(File), expect.objectContaining({ requestId: 4 }),
    ));
  });

  it('drops a linked request the loaded list no longer has', async () => {
    renderAt('/customer/documents?request=99');
    await screen.findByText('Signed contract');
    await userEvent.upload(screen.getByLabelText('File'), pdf());
    await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
    await waitFor(() => expect(svc.uploadDocument).toHaveBeenCalledWith(
      expect.any(File), expect.objectContaining({ requestId: null }),
    ));
  });
});
