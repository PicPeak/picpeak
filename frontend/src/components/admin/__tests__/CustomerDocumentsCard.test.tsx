/**
 * Admin → customer record → Documents card (#1444).
 *
 * A contract-linked document cannot be deleted (the server answers 409
 * DOCUMENT_CONTRACT_LINKED). The card has to say why and offer the one way
 * forward — unlinking — rather than a Delete that just fails.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { AdminCustomerDocument } from '../../../services/customerDocumentsAdmin.service';

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

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: () => true, hasAnyPermission: () => true, hasAllPermissions: () => true, isSuperAdmin: true,
  }),
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { contracts: false, projects: false } }),
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => d, formatDateTime: (d: string) => d }),
}));

const makeDoc = (over: Partial<AdminCustomerDocument>): AdminCustomerDocument => ({
  id: 1, name: 'agreement.pdf', sizeBytes: 1024, mimeType: 'application/pdf', sha256: 'x',
  uploaderType: 'admin', uploaderName: 'tester', status: 'clean', reviewedAt: null, reviewNote: null,
  shared: false, sharedAt: null, unsharedAt: null, eventId: 7, eventName: 'Wedding', projectId: 3,
  contractId: null, contractNumber: null, createdAt: '2026-09-01T10:00:00Z',
  customerViewCount: 0, customerFirstViewedAt: null, customerLastViewedAt: null,
  ...over,
});

let docs: AdminCustomerDocument[] = [];
const removeSpy = vi.fn(async () => undefined);
const setLinksSpy = vi.fn(async () => undefined);

vi.mock('../../../services/customerDocumentsAdmin.service', () => ({
  customerDocumentsAdminService: {
    list: vi.fn(async () => ({ documents: docs, limits: { maxUploadBytes: 1, quotaBytes: 1, usedBytes: 0 } })),
    remove: (...a: unknown[]) => removeSpy(...(a as [])),
    setLinks: (...a: unknown[]) => setLinksSpy(...(a as [])),
  },
}));
vi.mock('../../../services/contracts.service', () => ({ contractsService: { list: vi.fn() } }));

import { ConfirmDialogProvider } from '../../common';
import { CustomerDocumentsCard } from '../CustomerDocumentsCard';

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>
        <CustomerDocumentsCard customerId={5} events={[{ id: 7, eventName: 'Wedding' }]} />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
}

describe('CustomerDocumentsCard — contract-linked documents', () => {
  beforeEach(() => {
    removeSpy.mockClear();
    setLinksSpy.mockClear();
  });

  it('explains why a linked document cannot be deleted and unlinks it, keeping the other links', async () => {
    docs = [makeDoc({ contractId: 12, contractNumber: 'K-12' })];
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('agreement.pdf is linked to a contract');
    await userEvent.click(screen.getByRole('button', { name: 'Unlink from contract' }));

    await waitFor(() => expect(setLinksSpy).toHaveBeenCalledWith(5, 1, { eventId: 7, projectId: 3, contractId: null }));
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('offers the unlink when the server refuses a delete because the link appeared meanwhile', async () => {
    docs = [makeDoc({ id: 2, contractId: null })];
    removeSpy.mockRejectedValueOnce({ response: { status: 409, data: { code: 'DOCUMENT_CONTRACT_LINKED' } } });
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('button', { name: 'Unlink from contract' })).toBeInTheDocument();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('deletes an unlinked document after the usual confirmation', async () => {
    docs = [makeDoc({ id: 3 })];
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(5, 3));
    expect(setLinksSpy).not.toHaveBeenCalled();
  });
});
