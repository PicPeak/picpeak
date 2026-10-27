import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../../config/api';
import { toast } from 'react-toastify';
import { PaymentsTab } from '../PaymentsTab';
import type { PaymentSettings } from '../../../../services/payments.service';

vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: vi.fn() }, useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key }) }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../../config/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
const replacementKey = ['rk', 'test', crypto.randomUUID().replaceAll('-', '')].join('_');
const signingSecret = 'whsec_' + crypto.randomUUID().replaceAll('-', '');
const go = (user: ReturnType<typeof userEvent.setup>, label: RegExp) => user.click(screen.getByRole('button', { name: label }));
const stored: PaymentSettings = {
  source: 'settings', revision: 'revision-one', checkout_configured: true, webhook_configured: true,
  test_mode: true, unreadable: false, account_id: 'acct_test', api_verified_at: '2026-10-26T12:00:00Z',
  webhook_verified_at: null, webhook_url: 'https://photos.example.test/api/photo-sales/stripe/webhook',
  site_url: 'https://photos.example.test', site_url_ready: true,
  api_version: 'test-version', webhook_events: ['checkout.session.completed'],
};
async function open(data = stored) {
  vi.mocked(api.get).mockResolvedValue({ data });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><PaymentsTab /></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Add a restricted Stripe key/ }));
  const field = screen.getByLabelText('Stripe API key');
  return { client, field, user };
}
describe('installation Payments settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.put).mockResolvedValue({ data: { ...stored, revision: 'revision-two' } });
  });
  it('leaves saved secrets blank and saves only the credential being replaced', async () => {
    const { field, user } = await open();
    expect(field).toHaveValue(''); expect(field).toHaveAttribute('type', 'password');
    await go(user, /Set up payment notifications/);
    expect(screen.getByLabelText('Webhook signing secret')).toHaveValue('');
    await go(user, /Add a restricted Stripe key/);
    await user.type(screen.getByLabelText('Stripe API key'), replacementKey);
    await go(user, /Save and check access/);
    expect(screen.getByRole('button', { name: 'Check saved API access' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/settings/payments', { revision: 'revision-one', secret_key: replacementKey }));
    await screen.findByRole('heading', { name: 'Test a purchase' });
    await go(user, /Add a restricted Stripe key/);
    expect(screen.getByLabelText('Stripe API key')).toHaveValue('');
  });
  it('discards typed secrets without sending them', async () => {
    const { field, user } = await open(); await user.type(field, 'temporary');
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(field).toHaveValue(''); expect(api.put).not.toHaveBeenCalled();
  });
  it('shows environment-managed configuration without an editable credential form', async () => {
    const { field, user } = await open({ ...stored, source: 'environment' });
    await go(user, /Set up payment notifications/);
    expect(field).toBeDisabled();
    expect(screen.getByLabelText('Webhook signing secret')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByText('STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is set in the server environment. These values take precedence as a pair. Ask the server operator to remove both variables before managing credentials here.')).toBeInTheDocument();
  });
  it('reports API access separately from signature verification', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { account_id: 'acct_test', test_mode: true } });
    const { user } = await open();
    await go(user, /Save and check access/);
    await user.click(screen.getByRole('button', { name: 'Check saved API access' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/settings/payments/test'));
    expect(screen.getByText('This check creates no payments. It does not verify write permissions, refunds, or webhook delivery. Save any changes before checking.')).toBeInTheDocument();
    await go(user, /Test a purchase/);
    expect(screen.getByText('No signed webhook received for these credentials')).toBeInTheDocument();
  });
  it('keeps the draft revision when a background refresh sees another admin save', async () => {
    const { client, field, user } = await open();
    await user.type(field, replacementKey);
    act(() => client.setQueryData(['admin-payments'], { ...stored, revision: 'someone-else-saved' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/settings/payments', expect.objectContaining({ revision: 'revision-one' })));
  });
  it('retains a failed draft so it can be corrected or discarded', async () => {
    vi.mocked(api.put).mockRejectedValue({ response: { status: 422, data: { error: 'Unable to verify' } } });
    const { field, user } = await open(); await user.type(field, replacementKey);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(field).toHaveValue(replacementKey);
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
  });
  it('keeps first-time credentials across steps and saves them only through the save bar', async () => {
    const { user } = await open({ ...stored, source: 'none', checkout_configured: false, webhook_configured: false });
    await user.type(screen.getByLabelText('Stripe API key'), replacementKey);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await go(user, /Set up payment notifications/);
    await user.type(screen.getByLabelText('Webhook signing secret'), signingSecret);
    await go(user, /Save and check access/);
    expect(screen.getAllByText('New value entered')).toHaveLength(2);
    expect(screen.queryByDisplayValue(replacementKey)).not.toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
    await go(user, /Add a restricted Stripe key/);
    expect(screen.getByLabelText('Stripe API key')).toHaveValue(replacementKey);
    await go(user, /Set up payment notifications/);
    expect(screen.getByLabelText('Webhook signing secret')).toHaveValue(signingSecret);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/settings/payments', {
      revision: 'revision-one', secret_key: replacementKey, webhook_secret: signingSecret,
    }));
    await screen.findByRole('heading', { name: 'Test a purchase' });
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();
  });
  it('moves keyboard focus to the new step instead of leaving it past the fields', async () => {
    const { user } = await open();
    await go(user, /Check your gallery address/);
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByRole('heading', { name: 'Add a restricted Stripe key' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Open Stripe API keys' })).toHaveFocus();
  });
  it('explains a missing HTTPS address without claiming that a URL format proves Stripe delivery', async () => {
    const { user } = await open({ ...stored, site_url: '', site_url_ready: false, webhook_url: '' });
    await go(user, /Check your gallery address/);
    expect(screen.getByText('Set your public HTTPS address first')).toBeInTheDocument();
    expect(screen.getByText(/This checks the address format, not delivery/)).toBeInTheDocument();
    await go(user, /Set up payment notifications/);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });
  it('copies only the public endpoint and event names, without saving a draft', async () => {
    const { user } = await open();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await go(user, /Set up payment notifications/);
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(copy).toHaveBeenLastCalledWith(stored.webhook_url);
    await user.click(screen.getByRole('button', { name: 'Copy event names' }));
    expect(copy).toHaveBeenLastCalledWith(stored.webhook_events.join('\n'));
    expect(api.put).not.toHaveBeenCalled();
  });
  it('offers a manual copying fallback when clipboard access is denied', async () => {
    const { user } = await open();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard denied'));
    await go(user, /Set up payment notifications/);
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(toast.error).toHaveBeenCalledWith('Could not copy. Select the text and copy it manually.');
  });
  it('refreshes signed-notification status without treating it as a verified purchase or refund', async () => {
    const { user } = await open();
    await go(user, /Test a purchase/);
    vi.mocked(api.get).mockResolvedValue({ data: { ...stored, webhook_verified_at: '2026-10-27T12:00:00Z' } });
    await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
    expect(await screen.findByText('Signed webhook received')).toBeInTheDocument();
    expect(screen.getByText(/Confirm order fulfilment separately with a test purchase/)).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });
  it('invalidates a probe result when a background refresh changes the credential revision', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { account_id: 'acct_test', test_mode: true } });
    const { client, user } = await open({ ...stored, source: 'environment', api_verified_at: null });
    await go(user, /Save and check access/);
    await user.click(screen.getByRole('button', { name: 'Check saved API access' }));
    await screen.findByText('The saved API key passed read-only Account and Checkout Sessions checks.');
    act(() => client.setQueryData(['admin-payments'], { ...stored, source: 'environment', revision: 'another-key', api_verified_at: null }));
    await waitFor(() => expect(screen.queryByText('The saved API key passed read-only Account and Checkout Sessions checks.')).not.toBeInTheDocument());
  });
});
