/**
 * What the contract editor tells the admin when a save fails (issue 1447).
 *
 * A failed create used to end in a toast reading "An unexpected error
 * occurred": no field, no hint whether a draft now existed, and a second click
 * while the first request was still in flight sent a second create. The editor
 * now shows an inline summary that says whether the draft was saved, names the
 * fields to fix, gives a reference id for server faults, and sends one
 * idempotency key per draft so a retry after a lost response cannot create a
 * duplicate.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const create = vi.fn();
const update = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return {
    ...actual,
    contractsService: {
      ...actual.contractsService,
      create: (...args: unknown[]) => create(...args),
      get: vi.fn(),
      update: (...args: unknown[]) => update(...args),
      listBlocks: vi.fn().mockResolvedValue({ blocks: [] }),
    },
  };
});

vi.mock('../../../../components/admin/CustomerPicker', async () => {
  const { createElement } = await vi.importActual<typeof import('react')>('react');
  return {
    CustomerPicker: ({ onSelect }: { onSelect: (c: unknown) => void }) => createElement(
      'button',
      { type: 'button', onClick: () => onSelect({ id: 3, email: 'kunde@example.com' }) },
      'pick customer',
    ),
  };
});
vi.mock('../../../../components/admin/ProjectSelect', () => ({ ProjectSelect: () => null }));
vi.mock('../../../../services/customerAdmin.service', () => ({ customerAdminService: { get: vi.fn() } }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    dateFormat: 'dd.MM.yyyy',
    timeFormat: '24h',
    formatTime: (v: string) => v,
    format: (d: unknown) => String(d),
    formatDate: (d: unknown) => String(d),
  }),
}));

import { ContractEditorPage } from '../ContractEditorPage';

const httpError = (status: number, data: Record<string, unknown>) => Object.assign(
  new Error(`Request failed with status code ${status}`),
  { isAxiosError: true, request: {}, response: { status, data } },
);
const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {}, code: 'ERR_NETWORK' });

function DetailStub() {
  const { id } = useParams();
  return <p>contract detail {id}</p>;
}

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/clients/contracts/new']}>
        <Routes>
          <Route path="/admin/clients/contracts/new" element={<ContractEditorPage />} />
          <Route path="/admin/clients/contracts/:id" element={<DetailStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('pick customer'));
  return screen.getByRole('button', { name: /create draft/i });
}

describe('ContractEditorPage save failures (issue 1447)', () => {
  beforeEach(() => { create.mockReset(); update.mockReset(); });

  it('sends one create for a double click, shows the pending state, and re-enables after a failure', async () => {
    let rejectCreate: (e: unknown) => void = () => {};
    create.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const button = renderEditor();

    fireEvent.click(button);
    fireEvent.click(button);

    // The mutation runs its function asynchronously, so wait for the pending
    // state before counting.
    const saving = await screen.findByRole('button', { name: /saving/i });
    expect(saving).toBeDisabled();
    expect(create).toHaveBeenCalledTimes(1);

    rejectCreate(httpError(500, { error: 'An unexpected error occurred', code: 'INTERNAL_ERROR', requestId: 'req-pending' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /create draft/i })).toBeEnabled());
  });

  it('names the fields to fix, says the draft was not saved, and moves focus to the summary', async () => {
    create.mockRejectedValueOnce(httpError(400, {
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      requestId: 'req-400',
      details: [
        { field: 'title', message: 'Invalid value' },
        { field: 'blocks[0].position', message: 'Invalid value' },
      ],
    }));
    const button = renderEditor();

    fireEvent.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The draft was not saved.');
    expect(alert).toHaveTextContent('Contract title: Keep it to 255 characters or fewer');
    expect(alert).toHaveTextContent('Blocks: Check the block selection');
    expect(alert).not.toHaveTextContent('Invalid value');
    await waitFor(() => expect(document.activeElement).toBe(alert));

    // The same problem is shown next to the field and wired to it.
    const titleInput = screen.getByPlaceholderText('e.g. Wedding contract Doe / Müller');
    expect(titleInput).toHaveAttribute('aria-invalid', 'true');
    const describedBy = titleInput.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)).toHaveTextContent('Keep it to 255 characters or fewer');
  });

  it('clears the summary once the admin edits a field', async () => {
    create.mockRejectedValueOnce(httpError(400, {
      error: 'Validation failed', code: 'VALIDATION_ERROR', details: [{ field: 'title', message: 'Invalid value' }],
    }));
    const button = renderEditor();
    fireEvent.click(button);
    await screen.findByRole('alert');

    fireEvent.change(screen.getByPlaceholderText('e.g. Wedding contract Doe / Müller'), { target: { value: 'Hochzeit' } });

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('gives a reference id for a server fault without claiming a draft exists', async () => {
    create.mockRejectedValueOnce(httpError(500, { error: 'An unexpected error occurred', code: 'INTERNAL_ERROR', requestId: 'req-500' }));
    const button = renderEditor();

    fireEvent.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The draft was not saved.');
    expect(alert).toHaveTextContent('Reference ID: req-500');
  });

  it('says a lost response may have saved the draft, and retries with the same key', async () => {
    create
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ contract: { id: 7 }, replayed: true });
    update.mockResolvedValueOnce({ contract: { id: 7 } });
    const button = renderEditor();

    fireEvent.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'We could not confirm whether the draft was saved. Saving again is safe — it will not create a second draft.',
    );

    fireEvent.click(await screen.findByRole('button', { name: /create draft/i }));

    await screen.findByText('contract detail 7');
    expect(create).toHaveBeenCalledTimes(2);
    const firstKey = create.mock.calls[0][1]?.idempotencyKey;
    expect(firstKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(create.mock.calls[1][1]?.idempotencyKey).toBe(firstKey);
  });

  it('applies what was edited after a lost response to the replayed draft', async () => {
    create
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ contract: { id: 7 }, replayed: true });
    update.mockResolvedValueOnce({ contract: { id: 7 } });
    const button = renderEditor();
    fireEvent.click(button);
    await screen.findByRole('alert');

    // The admin keeps working before saving again.
    fireEvent.change(screen.getByPlaceholderText('e.g. Wedding contract Doe / Müller'), { target: { value: 'Hochzeit Meier' } });
    fireEvent.click(await screen.findByRole('button', { name: /create draft/i }));

    await screen.findByText('contract detail 7');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe(7);
    expect(update.mock.calls[0][1]).toEqual(expect.objectContaining({ title: 'Hochzeit Meier' }));
  });

  it('says the draft exists when applying the latest changes to it fails, and saves again as an update', async () => {
    create
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ contract: { id: 7 }, replayed: true });
    update
      .mockRejectedValueOnce(httpError(500, { error: 'An unexpected error occurred', code: 'INTERNAL_ERROR', requestId: 'req-upd' }))
      .mockResolvedValueOnce({ contract: { id: 7 } });
    const button = renderEditor();
    fireEvent.click(button);
    await screen.findByRole('alert');
    fireEvent.click(await screen.findByRole('button', { name: /create draft/i }));

    const alert = await screen.findByText(/The draft was saved, but your latest changes were not/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Reference ID: req-upd');

    fireEvent.click(await screen.findByRole('button', { name: /create draft/i }));
    await screen.findByText('contract detail 7');
    // No third create: the draft already exists.
    expect(create).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('sends an idempotency key and the block selection with a successful create', async () => {
    create.mockResolvedValueOnce({ contract: { id: 12 } });
    const button = renderEditor();

    fireEvent.click(button);

    await screen.findByText('contract detail 12');
    const [payload, options] = create.mock.calls[0];
    expect(payload).toEqual(expect.objectContaining({ customerAccountId: 3, blocks: [] }));
    expect(options?.idempotencyKey).toEqual(expect.any(String));
    expect(options.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('links the legal notice to the CRM disclaimer documentation', () => {
    renderEditor();

    const link = screen.getByRole('link', { name: 'Read the CRM disclaimer' });
    expect(link).toHaveAttribute('href', 'https://docs.picpeak.app/features/crm/disclaimers');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
