/**
 * Customer portal → one document (`/customer/documents/:id`, #1444 slice 2).
 *
 * Each state the server can answer with has its own explanation — "no longer
 * shared" must not read like "removed", and neither like "still being
 * checked" — and a deep link survives the login and is asked for again
 * afterwards.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import type { CustomerDocument } from '../../../services/customer.service';

// Resolve against the REAL en.json so a missing key fails as a label.
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
        const base = lookup(k) ?? (typeof fb === 'string' ? `MISSING:${k}` : k);
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
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { branding_company_name: 'Studio Nord' } }),
}));

const { getDocument, downloadDocument, deleteDocument, auth } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  downloadDocument: vi.fn(async () => undefined),
  deleteDocument: vi.fn(async () => undefined),
  auth: { isAuthenticated: true },
}));
vi.mock('../../../services/customer.service', () => ({
  customerService: { getDocument, downloadDocument, deleteDocument },
}));
vi.mock('../../../contexts/CustomerAuthContext', () => ({
  useCustomerAuth: () => ({
    customer: { email: 'kim@example.com' },
    features: { documents: true },
    branding: { showLogo: false, showCompanyName: false },
    isAuthenticated: auth.isAuthenticated,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

import { ConfirmDialogProvider } from '../../../components/common';
import { CustomerDocumentPage } from '../CustomerDocumentPage';
import { CustomerLayout } from '../CustomerLayout';
import { safeCustomerReturnTo } from '../CustomerLoginPage';

const makeDoc = (over: Partial<CustomerDocument>): CustomerDocument => ({
  id: 5, name: 'contract.pdf', sizeBytes: 2048, uploadedBy: 'you', status: 'pending',
  downloadable: false, rejectionReason: null, eventId: null, eventName: null, eventSlug: null,
  contractId: null, createdAt: '2026-09-01T10:00:00Z', sharedAt: null, reviewedAt: null,
  ...over,
});
const httpError = (status: number, code?: string) => ({ response: { status, data: code ? { code } : {} } });

const Here: React.FC = () => {
  const loc = useLocation();
  return <span data-testid="here">{`${loc.pathname}${loc.search}`}</span>;
};

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={[path]}>
          <Here />
          <Routes>
            <Route path="/customer/login" element={<div>login page</div>} />
            <Route path="/customer" element={<CustomerLayout />}>
              <Route path="documents" element={<div>documents list</div>} />
              <Route path="documents/:id" element={<CustomerDocumentPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
}

describe('CustomerDocumentPage', () => {
  beforeEach(() => {
    getDocument.mockReset();
    downloadDocument.mockClear();
    auth.isAuthenticated = true;
  });

  it('shows an available document with its details and a download', async () => {
    getDocument.mockResolvedValue(makeDoc({
      name: 'offer.pdf', uploadedBy: 'studio', status: 'clean', downloadable: true,
      sharedAt: '2026-09-02T10:00:00Z', eventName: 'Wedding', eventSlug: 'wedding',
    }));
    renderAt('/customer/documents/5');
    expect(await screen.findByRole('heading', { name: 'offer.pdf' })).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Shared by your photographer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Wedding' })).toHaveAttribute('href', '/customer/events/wedding');
    await userEvent.click(screen.getByRole('button', { name: 'Download offer.pdf' }));
    expect(downloadDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
  });

  it('deletes an own upload after confirming and returns to the list', async () => {
    getDocument.mockResolvedValue(makeDoc({ status: 'pending', canDelete: true }));
    renderAt('/customer/documents/5');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete contract.pdf' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('documents list')).toBeInTheDocument();
    expect(deleteDocument).toHaveBeenCalledWith(5);
  });

  it('offers no Delete on a studio document', async () => {
    getDocument.mockResolvedValue(makeDoc({ uploadedBy: 'studio', status: 'clean', downloadable: true }));
    renderAt('/customer/documents/5');
    await screen.findByRole('heading', { name: 'contract.pdf' });
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it.each([
    ['pending', makeDoc({ status: 'pending' }), /waiting for review\. Every upload is checked by Studio Nord/],
    ['rejected with a note', makeDoc({ status: 'rejected', rejectionReason: 'Unsigned' }), /was not accepted: Unsigned/],
    ['rejected without a note', makeDoc({ status: 'rejected' }), /was not accepted\. Contact Studio Nord/],
  ])('explains a %s upload and offers no download', async (_label, doc, text) => {
    getDocument.mockResolvedValue(doc);
    renderAt('/customer/documents/5');
    await screen.findByRole('heading', { name: 'contract.pdf' });
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it.each([
    ['unshared', httpError(410, 'DOCUMENT_UNSHARED'), 'No longer shared', /no longer shared with you\. Ask Studio Nord/],
    ['removed', httpError(410, 'DOCUMENT_REMOVED'), 'Removed', /was removed and can no longer be opened/],
    ['not found', httpError(404, 'DOCUMENT_NOT_FOUND'), 'Document not found', /no document at this address/],
    ['disabled', httpError(403, 'CUSTOMER_FEATURE_DISABLED'), 'Documents are not available', /not available for your account/],
  ])('gives the %s state its own message', async (_label, err, title, body) => {
    getDocument.mockRejectedValue(err);
    renderAt('/customer/documents/5');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(body);
    expect(screen.queryByText(/MISSING:/)).toBeNull();
  });

  it('keeps a deep link through the login and asks the server again afterwards', async () => {
    auth.isAuthenticated = false;
    const view = renderAt('/customer/documents/5');
    expect(await screen.findByText('login page')).toBeInTheDocument();
    const target = new URLSearchParams(screen.getByTestId('here').textContent!.split('?')[1]).get('returnTo');
    expect(target).toBe('/customer/documents/5');
    expect(getDocument).not.toHaveBeenCalled();
    // The login page follows it back into the portal.
    expect(safeCustomerReturnTo(target)).toBe('/customer/documents/5');
    view.unmount();

    // Logged in, the page re-authorises the target: the server decides.
    auth.isAuthenticated = true;
    getDocument.mockRejectedValue(httpError(404, 'DOCUMENT_NOT_FOUND'));
    renderAt(target!);
    expect(await screen.findByRole('heading', { name: 'Document not found' })).toBeInTheDocument();
    expect(getDocument).toHaveBeenCalledWith(5);
  });
});
