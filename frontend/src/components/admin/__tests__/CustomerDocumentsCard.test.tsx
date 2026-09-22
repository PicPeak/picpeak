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

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toastMock }));
const env = vi.hoisted(() => ({
  projects: false,
  permissions: null as null | string[],
}));
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => {
    const has = (p: string) => env.permissions === null || env.permissions.includes(p);
    return {
      hasPermission: has, hasAnyPermission: () => true, hasAllPermissions: () => true,
      isSuperAdmin: env.permissions === null,
    };
  },
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { contracts: false, projects: env.projects } }),
}));
vi.mock('../../../services/projects.service', () => ({
  projectsService: {
    list: vi.fn(async () => [
      { id: 3, name: 'Own project', customerAccountId: 5 },
      { id: 4, name: 'Another customer', customerAccountId: 9 },
      { id: 6, name: 'No customer', customerAccountId: null },
    ]),
  },
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
let notifyOnShare = true;
const removeSpy = vi.fn(async () => undefined);
const setLinksSpy = vi.fn(async () => undefined);
const shareSpy = vi.fn(async (): Promise<string | undefined> => 'queued');

vi.mock('../../../services/customerDocumentsAdmin.service', () => ({
  customerDocumentsAdminService: {
    list: vi.fn(async () => ({
      documents: docs, limits: { maxUploadBytes: 1, quotaBytes: 1, usedBytes: 0 }, settings: { notifyOnShare },
    })),
    share: (...a: unknown[]) => shareSpy(...(a as [])),
    remove: (...a: unknown[]) => removeSpy(...(a as [])),
    setLinks: (...a: unknown[]) => setLinksSpy(...(a as [])),
  },
}));
vi.mock('../../../services/contracts.service', () => ({ contractsService: { list: vi.fn() } }));

import { ConfirmDialogProvider } from '../../common';
import { CustomerDocumentsCard } from '../CustomerDocumentsCard';

function renderCard(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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
    env.projects = false;
    env.permissions = null;
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
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderCard(qc);
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(5, 3));
    expect(setLinksSpy).not.toHaveBeenCalled();
    // The upload may have answered a request, which is open again now.
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey);
      expect(keys).toEqual(expect.arrayContaining([
        ['admin-customer-documents', 5], ['admin-customer-document-requests', 5], ['admin-customer-activity', 5],
      ]));
    });
  });
});

describe('CustomerDocumentsCard — project link (#1444)', () => {
  beforeEach(() => {
    setLinksSpy.mockClear();
    env.projects = true;
    env.permissions = null;
  });

  it('offers only this customer\'s projects and sends all three links together', async () => {
    docs = [makeDoc({ id: 8, projectId: null, eventId: 7, contractId: 12, contractNumber: 'K-12' })];
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /Link/ }));
    const pickers = await screen.findAllByRole('combobox', { name: 'Project' });
    const picker = pickers[pickers.length - 1];
    await waitFor(() => expect(within(picker).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['No project', 'Own project']));
    await userEvent.selectOptions(picker, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save links' }));
    // The contract picker is not available here (contracts flag off), so the
    // existing contract link is sent back unchanged rather than cleared.
    await waitFor(() => expect(setLinksSpy).toHaveBeenCalledWith(5, 8, { eventId: 7, projectId: 3, contractId: 12 }));
  });

  it('hides the picker without events.view and keeps the existing project link', async () => {
    env.permissions = ['customers.documents.manage'];
    docs = [makeDoc({ id: 9, projectId: 3, eventId: null })];
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /Link/ }));
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(setLinksSpy).toHaveBeenCalledWith(5, 9, { eventId: null, projectId: 3, contractId: null }));
  });
});

describe('CustomerDocumentsCard — share notification (#1444)', () => {
  beforeEach(() => {
    shareSpy.mockClear();
    toastMock.success.mockClear();
    toastMock.warning.mockClear();
    env.projects = false;
    env.permissions = null;
  });

  it('defaults the notify checkbox to the setting and sends the choice with a share', async () => {
    notifyOnShare = false;
    docs = [makeDoc({ id: 11, shared: false })];
    renderCard();
    const box = await screen.findByRole('checkbox', { name: 'Notify the customer by email' });
    await waitFor(() => expect(box).not.toBeChecked());
    await userEvent.click(screen.getByRole('button', { name: /^Share$/ }));
    await waitFor(() => expect(shareSpy).toHaveBeenCalledWith(5, 11, false));

    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: /^Share$/ }));
    await waitFor(() => expect(shareSpy).toHaveBeenLastCalledWith(5, 11, true));
    notifyOnShare = true;
  });

  it('says so when the share went through but the email could not be queued', async () => {
    shareSpy.mockResolvedValueOnce('failed');
    docs = [makeDoc({ id: 12, shared: false })];
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /^Share$/ }));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith(
      'Shared with the customer. The email to the customer could not be queued.',
    ));
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
