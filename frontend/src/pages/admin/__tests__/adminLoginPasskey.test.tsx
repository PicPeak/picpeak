/**
 * "Sign in with a passkey" on the admin login page (issue 1733). The button
 * is feature-detected and only offered on the address passkeys are bound to;
 * at the second step it appears when the account has a passkey.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

const login = vi.fn();
vi.mock('../../../contexts', () => ({
  useAdminAuth: () => ({ isAuthenticated: false, login }),
}));

vi.mock('../../../contexts/AdminDarkModeContext', () => ({
  useAdminDarkMode: () => ({ isDark: false }),
}));

vi.mock('../../../services/setup.service', () => ({
  setupService: { getSetupStatus: vi.fn().mockResolvedValue({ needsAdmin: false }) },
}));

vi.mock('../../../components/common/ReCaptcha', () => ({ ReCaptcha: () => null }));

let settings: Record<string, unknown> = {};
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: settings }),
}));

const passkey = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../../../services/passkey.service', () => ({ passkeyService: passkey }));

const auth = vi.hoisted(() => ({ adminLogin: vi.fn(), adminLoginMfa: vi.fn() }));
vi.mock('../../../services/auth.service', () => ({ authService: auth }));

import { AdminLoginPage } from '../AdminLoginPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminLoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const supportPasskeys = () => {
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create: vi.fn(), get: vi.fn() } });
};

const BUTTON = 'adminLogin.passkey.signIn';

beforeEach(() => {
  settings = { branding_hide_powered_by: true, passkey_origin: window.location.origin };
  passkey.login.mockReset();
  auth.adminLogin.mockReset();
  login.mockReset();
  supportPasskeys();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminLoginPage passkey button', () => {
  it('signs in without a password and carries "remember me"', async () => {
    passkey.login.mockResolvedValue({ user: { id: 1, username: 'admin' } });
    renderPage();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));

    await waitFor(() => expect(passkey.login).toHaveBeenCalledWith({ rememberMe: true }));
    await waitFor(() => expect(login).toHaveBeenCalledWith(undefined, { id: 1, username: 'admin' }));
  });

  it('is hidden when the browser has no passkey support', () => {
    vi.unstubAllGlobals();
    renderPage();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it.each([
    ['the install offers none', null],
    ['the page is open on another address', 'https://photos.example.com'],
  ])('is hidden when %s', (_label, origin) => {
    settings = { ...settings, passkey_origin: origin };
    renderPage();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('is hidden in SSO-only mode along with the password form', () => {
    settings = { ...settings, oidc_enabled: true, oidc_local_login_disabled: true };
    renderPage();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with SSO' })).toBeInTheDocument();
  });

  it.each([
    ['a dismissed or timed-out prompt', Object.assign(new Error('x'), { name: 'NotAllowedError' }), 'adminLogin.passkey.cancelled'],
    ['a browser that cannot do it', Object.assign(new Error('x'), { name: 'SecurityError' }), 'adminLogin.passkey.unsupported'],
    ['a rejected passkey', { response: { status: 401, data: { code: 'PASSKEY_INVALID' } } }, 'adminLogin.passkey.failed'],
  ])('explains %s', async (_label, error, message) => {
    passkey.login.mockRejectedValue(error);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('offers a passkey at the second step only when the account has one', async () => {
    const fillAndSubmit = () => {
      fireEvent.change(screen.getByLabelText('adminLogin.emailLabel'), { target: { value: 'a@example.com' } });
      fireEvent.change(screen.getByLabelText('adminLogin.passwordLabel'), { target: { value: 'correct-horse' } });
      fireEvent.click(screen.getByRole('button', { name: 'adminLogin.signIn' }));
    };

    auth.adminLogin.mockResolvedValue({ mfaRequired: true, mfaToken: 'tok', passkeyAvailable: false });
    const first = renderPage();
    fillAndSubmit();
    await screen.findByText('adminLogin.mfa.title');
    expect(screen.queryByRole('button', { name: 'adminLogin.passkey.useInstead' })).toBeNull();
    first.unmount();

    auth.adminLogin.mockResolvedValue({ mfaRequired: true, mfaToken: 'tok', passkeyAvailable: true });
    passkey.login.mockResolvedValue({ user: { id: 1, username: 'admin' } });
    renderPage();
    fillAndSubmit();
    fireEvent.click(await screen.findByRole('button', { name: 'adminLogin.passkey.useInstead' }));
    await waitFor(() => expect(passkey.login).toHaveBeenCalledWith({ mfaToken: 'tok' }));
    await waitFor(() => expect(login).toHaveBeenCalled());
  });
});
