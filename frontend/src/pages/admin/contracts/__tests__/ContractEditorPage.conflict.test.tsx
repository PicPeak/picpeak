/**
 * The contract editor after another admin saved first (#1445): a 409
 * CONTRACT_CONFLICT keeps the form as typed, and the admin keeps their
 * version (saved over the new lock) or takes the other one. A refetch in the
 * background never overwrites the form.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const get = vi.fn();
const update = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return {
    ...actual,
    contractsService: {
      ...actual.contractsService,
      get: (...args: unknown[]) => get(...args),
      update: (...args: unknown[]) => update(...args),
      listBlocks: vi.fn().mockResolvedValue({ blocks: [] }),
    },
  };
});
vi.mock('../../../../components/admin/CustomerPicker', () => ({ CustomerPicker: () => null }));
vi.mock('../../../../components/admin/ProjectSelect', () => ({ ProjectSelect: () => null }));
vi.mock('../../../../services/customerAdmin.service', () => ({ customerAdminService: { get: vi.fn() } }));
vi.mock('../SignersEditorCard', () => ({ SignersEditorCard: () => null }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    dateFormat: 'dd.MM.yyyy', timeFormat: '24h', formatTime: (v: string) => v, format: (d: unknown) => String(d), formatDate: (d: unknown) => String(d),
  }),
}));

import { ContractEditorPage } from '../ContractEditorPage';

const contract = (lockVersion: number, title: string) => ({
  contract: {
    id: 9, customerAccountId: 3, customer: { email: 'k@example.com' }, title, eventName: '', eventDate: '', eventTimeStart: '',
    eventTimeEnd: '', introText: '', outroText: '', language: 'de', issueDate: '2026-09-22', validUntil: '', projectId: null,
    lockVersion, attachments: [], inclusions: [], status: 'draft',
  },
});
const conflictError = () => Object.assign(new Error('409'), {
  isAxiosError: true, request: {}, response: { status: 409, data: { code: 'CONTRACT_CONFLICT', error: 'changed elsewhere' } },
});

function renderEditor(cached?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (cached) client.setQueryData(['contract', 9], cached);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/clients/contracts/9/edit']}>
        <Routes>
          <Route path="/admin/clients/contracts/:id/edit" element={<ContractEditorPage />} />
          <Route path="/admin/clients/contracts/:id" element={<p>detail</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const titleField = () => screen.getByDisplayValue(/Titel/) as HTMLInputElement;

describe('ContractEditorPage conflict', () => {
  beforeEach(() => { get.mockReset(); update.mockReset(); });

  it('keeps the form on a 409 and "Keep mine" saves it over the newer lock', async () => {
    get.mockResolvedValue(contract(2, 'Alter Titel'));
    update.mockRejectedValueOnce(conflictError()).mockResolvedValueOnce({});
    renderEditor();
    await waitFor(() => expect(titleField().value).toBe('Alter Titel'));
    fireEvent.change(titleField(), { target: { value: 'Mein Titel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Changed by someone else.')).toBeInTheDocument();
    expect(titleField().value).toBe('Mein Titel');
    expect(screen.queryByText('Your changes were not saved.')).not.toBeInTheDocument();

    get.mockResolvedValue(contract(5, 'Ihr Titel'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(9, expect.objectContaining({ lockVersion: 5, title: 'Mein Titel' })));
    expect(await screen.findByText('detail')).toBeInTheDocument();
  });

  it('"Take theirs" loads the other version', async () => {
    get.mockResolvedValue(contract(2, 'Alter Titel'));
    update.mockRejectedValueOnce(conflictError());
    renderEditor();
    await waitFor(() => expect(titleField().value).toBe('Alter Titel'));
    fireEvent.change(titleField(), { target: { value: 'Mein Titel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Changed by someone else.');

    get.mockResolvedValue(contract(5, 'Ihr Titel'));
    fireEvent.click(screen.getByRole('button', { name: 'Take theirs' }));
    await waitFor(() => expect(titleField().value).toBe('Ihr Titel'));
    expect(screen.queryByText('Changed by someone else.')).not.toBeInTheDocument();
  });

  it('a newer server copy replaces an untouched form, so no conflict of its own making follows', async () => {
    get.mockResolvedValue(contract(2, 'Alter Titel'));
    update.mockResolvedValue({});
    const client = renderEditor();
    await waitFor(() => expect(titleField().value).toBe('Alter Titel'));
    get.mockResolvedValue(contract(3, 'Neuer Titel'));
    await client.refetchQueries({ queryKey: ['contract', 9] });
    await waitFor(() => expect(titleField().value).toBe('Neuer Titel'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(9, expect.objectContaining({ lockVersion: 3 })));
  });

  it('opened with the contract already cached, a newer server copy still replaces the untouched form', async () => {
    get.mockResolvedValue(contract(2, 'Alter Titel'));
    update.mockResolvedValue({});
    const client = renderEditor(contract(2, 'Alter Titel'));
    await waitFor(() => expect(titleField().value).toBe('Alter Titel'));
    get.mockResolvedValue(contract(3, 'Neuer Titel'));
    await client.refetchQueries({ queryKey: ['contract', 9] });
    await waitFor(() => expect(titleField().value).toBe('Neuer Titel'));
  });

  it('a background refetch does not overwrite what is being typed', async () => {
    get.mockResolvedValue(contract(2, 'Alter Titel'));
    const client = renderEditor();
    await waitFor(() => expect(titleField().value).toBe('Alter Titel'));
    fireEvent.change(titleField(), { target: { value: 'Mein Titel' } });
    get.mockResolvedValue(contract(3, 'Anderer Titel'));
    await client.refetchQueries({ queryKey: ['contract', 9] });
    expect(titleField().value).toBe('Mein Titel');
  });
});
