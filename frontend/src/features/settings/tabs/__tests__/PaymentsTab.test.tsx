import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../../config/api';
import { PaymentsTab } from '../PaymentsTab';

vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: vi.fn() }, useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key }) }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../../config/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
const stored = {
  source: 'settings', revision: 'revision-one', checkout_configured: true, webhook_configured: true,
  test_mode: true, unreadable: false, account_id: 'acct_test', api_verified_at: '2026-10-26T12:00:00Z',
  webhook_verified_at: null, webhook_url: 'https://photos.example.test/api/photo-sales/stripe/webhook',
  api_version: 'test-version', webhook_events: ['checkout.session.completed'],
};
async function open(data = stored) {
  vi.mocked(api.get).mockResolvedValue({ data });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><PaymentsTab /></QueryClientProvider>);
  const field = await screen.findByLabelText('settings.payments.apiKey');
  return { client, field, user: userEvent.setup() };
}
describe('installation Payments settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.put).mockResolvedValue({ data: { ...stored, revision: 'revision-two' } });
  });
  it('leaves saved secrets blank and saves only the credential being replaced', async () => {
    const { field, user } = await open();
    expect(field).toHaveValue(''); expect(field).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('settings.payments.webhookSecret')).toHaveValue('');
    await user.type(field, 'rk_test_replacement');
    expect(screen.getByRole('button', { name: 'settings.payments.checkApi' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/settings/payments', { revision: 'revision-one', secret_key: 'rk_test_replacement' }));
    await waitFor(() => expect(field).toHaveValue(''));
  });
  it('discards typed secrets without sending them', async () => {
    const { field, user } = await open(); await user.type(field, 'temporary');
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(field).toHaveValue(''); expect(api.put).not.toHaveBeenCalled();
  });
  it('shows environment-managed configuration without an editable credential form', async () => {
    const { field } = await open({ ...stored, source: 'environment' });
    expect(field).toBeDisabled();
    expect(screen.getByLabelText('settings.payments.webhookSecret')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByText('settings.payments.serverManagedHelp')).toBeInTheDocument();
  });
  it('reports API access separately from signature verification', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { account_id: 'acct_test', test_mode: true } });
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'settings.payments.checkApi' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/settings/payments/test'));
    expect(screen.getByText('settings.payments.webhookUnseen')).toBeInTheDocument();
    expect(screen.getByText('settings.payments.checkLimit')).toBeInTheDocument();
  });
  it('keeps the draft revision when a background refresh sees another admin save', async () => {
    const { client, field, user } = await open();
    await user.type(field, 'rk_test_replacement');
    act(() => client.setQueryData(['admin-payments'], { ...stored, revision: 'someone-else-saved' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/settings/payments', expect.objectContaining({ revision: 'revision-one' })));
  });
  it('retains a failed draft so it can be corrected or discarded', async () => {
    vi.mocked(api.put).mockRejectedValue({ response: { status: 422, data: { error: 'Unable to verify' } } });
    const { field, user } = await open(); await user.type(field, 'rk_test_replacement');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(field).toHaveValue('rk_test_replacement');
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
  });
});
