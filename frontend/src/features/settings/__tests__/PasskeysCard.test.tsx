/**
 * The Passkeys card on the admin's own account (issue 1733): list with last
 * use, add (name + current password, then the browser prompt), remove behind
 * the current password, and a stated reason wherever passkeys cannot work.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, opts?: Record<string, unknown>) =>
        (opts && typeof opts === 'object' ? `${k} ${JSON.stringify(opts)}` : k),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => `D(${d.slice(0, 10)})` }),
}));

const service = vi.hoisted(() => ({
  getStatus: vi.fn(),
  register: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../../services/passkey.service', () => ({ passkeyService: service }));

import { PasskeysCard } from '../components/PasskeysCard';

const status = (over: Record<string, unknown> = {}) => ({
  available: true,
  reason: null,
  rpId: 'localhost',
  origin: window.location.origin,
  max: 10,
  mfaEnabled: false,
  passkeys: [],
  ...over,
});

const laptop = { id: 7, name: 'Laptop', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: '2026-10-11T08:00:00.000Z' };
const key = { id: 8, name: 'YubiKey', createdAt: '2026-10-02T10:00:00.000Z', lastUsedAt: null };

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PasskeysCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(service).forEach((fn) => fn.mockReset());
  // jsdom has no WebAuthn; the card feature-detects it.
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create: vi.fn(), get: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PasskeysCard', () => {
  it('lists passkeys with when they were added and last used', async () => {
    service.getStatus.mockResolvedValue(status({ passkeys: [laptop, key] }));
    renderCard();

    const first = (await screen.findByText('Laptop')).closest('li')!;
    expect(first.textContent).toContain('settings.passkeys.addedOn {"date":"D(2026-10-01)"}');
    expect(first.textContent).toContain('settings.passkeys.lastUsed {"date":"D(2026-10-11)"}');
    const second = screen.getByText('YubiKey').closest('li')!;
    expect(second.textContent).toContain('settings.passkeys.neverUsed');
    // Says which address the passkeys are bound to.
    expect(screen.getByText('settings.passkeys.domainNote {"domain":"localhost"}')).toBeInTheDocument();
  });

  it('adds a passkey with a name and the current password', async () => {
    service.getStatus.mockResolvedValue(status());
    service.register.mockResolvedValue({ ...laptop });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'settings.passkeys.add' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));
    expect(screen.getByText('settings.passkeys.nameRequired')).toBeInTheDocument();
    expect(service.register).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('settings.passkeys.nameLabel'), { target: { value: ' Laptop ' } });
    fireEvent.change(screen.getByLabelText('settings.passkeys.passwordLabel'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));

    await waitFor(() => expect(service.register).toHaveBeenCalledWith('Laptop', 'secret'));
    // Back to the closed state, list refetched.
    await screen.findByRole('button', { name: 'settings.passkeys.add' });
    expect(service.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // The login page offers a passkey only while one is registered, and reads
  // that from the cached public settings.
  it('marks the public settings stale after a passkey is added', async () => {
    service.getStatus.mockResolvedValue(status());
    service.register.mockResolvedValue({ ...laptop });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['public-settings'], { passkey_origin: null });
    render(<QueryClientProvider client={qc}><PasskeysCard /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.passkeys.add' }));
    fireEvent.change(screen.getByLabelText('settings.passkeys.nameLabel'), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText('settings.passkeys.passwordLabel'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));

    await waitFor(() => expect(qc.getQueryState(['public-settings'])?.isInvalidated).toBe(true));
  });

  // A passkey signs in without the authenticator code, so an account with
  // two-factor authentication gives one to add it.
  it('asks for an authenticator code as well when the account has two-factor authentication', async () => {
    service.getStatus.mockResolvedValue(status({ mfaEnabled: true }));
    service.register.mockResolvedValue({ ...laptop });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'settings.passkeys.add' }));
    fireEvent.change(screen.getByLabelText('settings.passkeys.nameLabel'), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText('settings.passkeys.passwordLabel'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));
    expect(screen.getByText('settings.passkeys.codeRequired')).toBeInTheDocument();
    expect(service.register).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('settings.passkeys.codeLabel'), { target: { value: ' 123456 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));
    await waitFor(() => expect(service.register).toHaveBeenCalledWith('Laptop', 'secret', '123456'));
  });

  it('shows no code field without two-factor authentication', async () => {
    service.getStatus.mockResolvedValue(status());
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'settings.passkeys.add' }));
    expect(screen.queryByLabelText('settings.passkeys.codeLabel')).toBeNull();
  });

  it('names a refused code and clears the field', async () => {
    service.getStatus.mockResolvedValue(status({ mfaEnabled: true }));
    service.register.mockRejectedValue({ response: { data: { code: 'MFA_INVALID', error: 'Invalid verification code' } } });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'settings.passkeys.add' }));
    fireEvent.change(screen.getByLabelText('settings.passkeys.nameLabel'), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText('settings.passkeys.passwordLabel'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('settings.passkeys.codeLabel'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));

    expect(await screen.findByText('settings.passkeys.errors.wrongCode')).toBeInTheDocument();
    expect((screen.getByLabelText('settings.passkeys.codeLabel') as HTMLInputElement).value).toBe('');
  });

  it.each([
    ['NotAllowedError', 'settings.passkeys.errors.cancelled'],
    ['InvalidStateError', 'settings.passkeys.errors.exists'],
    ['NotSupportedError', 'settings.passkeys.errors.unsupported'],
  ])('explains a %s from the browser prompt', async (name, message) => {
    service.getStatus.mockResolvedValue(status());
    service.register.mockRejectedValue(Object.assign(new Error('x'), { name }));
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'settings.passkeys.add' }));
    fireEvent.change(screen.getByLabelText('settings.passkeys.nameLabel'), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText('settings.passkeys.passwordLabel'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    // The form stays open so the attempt can be repeated.
    expect(screen.getByLabelText('settings.passkeys.nameLabel')).toBeInTheDocument();
  });

  it('names a wrong password', async () => {
    service.getStatus.mockResolvedValue(status());
    service.register.mockRejectedValue({ response: { status: 400, data: { code: 'PASSWORD_INCORRECT', error: 'x' } } });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'settings.passkeys.add' }));
    fireEvent.change(screen.getByLabelText('settings.passkeys.nameLabel'), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText('settings.passkeys.passwordLabel'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passkeys.continue' }));
    expect(await screen.findByText('settings.passkeys.errors.wrongPassword')).toBeInTheDocument();
  });

  it('removes a passkey only with the current password', async () => {
    service.getStatus.mockResolvedValue(status({ passkeys: [laptop] }));
    service.remove.mockResolvedValue(undefined);
    renderCard();

    const row = (await screen.findByText('Laptop')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'settings.passkeys.remove' }));
    fireEvent.click(within(row).getByRole('button', { name: 'settings.passkeys.removeConfirm' }));
    expect(within(row).getByText('settings.passkeys.passwordRequired')).toBeInTheDocument();
    expect(service.remove).not.toHaveBeenCalled();

    fireEvent.change(within(row).getByLabelText('settings.passkeys.passwordLabel'), { target: { value: 'secret' } });
    fireEvent.click(within(row).getByRole('button', { name: 'settings.passkeys.removeConfirm' }));
    await waitFor(() => expect(service.remove).toHaveBeenCalledWith(7, 'secret'));
  });

  it('renames a passkey', async () => {
    service.getStatus.mockResolvedValue(status({ passkeys: [laptop] }));
    service.rename.mockResolvedValue(undefined);
    renderCard();

    const row = (await screen.findByText('Laptop')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'settings.passkeys.rename' }));
    fireEvent.change(within(row).getByLabelText('settings.passkeys.nameLabel'), { target: { value: 'Work laptop' } });
    fireEvent.click(within(row).getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(service.rename).toHaveBeenCalledWith(7, 'Work laptop'));
  });

  it.each(['ip_address', 'insecure_origin', 'not_configured', 'sso_only', 'sso_account'])(
    'says why passkeys are unavailable (%s) and offers no add button',
    async (reason) => {
      service.getStatus.mockResolvedValue(status({ available: false, reason, passkeys: [laptop] }));
      renderCard();

      expect(await screen.findByText(new RegExp(`^settings\\.passkeys\\.unavailable\\.${reason}`))).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'settings.passkeys.add' })).toBeNull();
      // What is already registered stays visible and removable.
      expect(screen.getByText('Laptop')).toBeInTheDocument();
    },
  );

  it('says so when the admin is open on another address than the passkeys are bound to', async () => {
    service.getStatus.mockResolvedValue(status({ origin: 'https://photos.example.com', rpId: 'photos.example.com' }));
    renderCard();
    expect(await screen.findByText(
      'settings.passkeys.unavailable.origin_mismatch {"origin":"https://photos.example.com"}',
    )).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.passkeys.add' })).toBeNull();
  });

  it('says so when the browser has no passkey support', async () => {
    vi.unstubAllGlobals();
    service.getStatus.mockResolvedValue(status());
    renderCard();
    expect(await screen.findByText(/^settings\.passkeys\.unavailable\.unsupported/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.passkeys.add' })).toBeNull();
  });

  it('shows a load failure as a failure, with a retry', async () => {
    service.getStatus.mockRejectedValue(new Error('boom'));
    renderCard();
    expect(await screen.findByText('settings.passkeys.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText('settings.passkeys.empty')).toBeNull();
  });
});
