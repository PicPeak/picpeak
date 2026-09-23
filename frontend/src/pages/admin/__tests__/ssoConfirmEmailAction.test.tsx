/**
 * An SSO sign-in refused with `email_unverified` tells the admin to have a
 * Super Admin confirm their address. Until this action existed, the only way
 * to do that was a hand-made `PUT /admin/users/:id` — the Users page sent
 * `role_id` and nothing else.
 *
 * The row action re-saves the address exactly as it stands, which is what
 * flips `email_link_eligible` back to true for a super_admin actor
 * (userManagementService, migration 227).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = typeof fb === 'string' ? fb : k;
        const vars = (typeof fb === 'object' && fb !== null ? fb : opts) as
          | Record<string, unknown>
          | undefined;
        if (!vars) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars[name] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from 'react-toastify';

let superAdmin = true;
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: () => true,
    hasAnyPermission: () => true,
    hasAllPermissions: () => true,
    isSuperAdmin: superAdmin,
    isLoading: false,
  }),
}));

const getUsers = vi.fn();
const updateUser = vi.fn();
vi.mock('../../../services/userManagement.service', () => ({
  userManagementService: {
    getUsers: (...a: unknown[]) => getUsers(...a),
    getRoles: vi.fn().mockResolvedValue([]),
    getInvitations: vi.fn().mockResolvedValue([]),
    updateUser: (...a: unknown[]) => updateUser(...a),
    createInvitation: vi.fn(),
    cancelInvitation: vi.fn(),
    deactivateUser: vi.fn(),
    activateUser: vi.fn(),
    deleteUser: vi.fn(),
  },
}));

import { UserManagementPage } from '../UserManagementPage';

const adminUser = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  username: 'mara',
  email: 'mara@example.com',
  isActive: true,
  lastLogin: null,
  roleId: 2,
  roleName: 'admin',
  roleDisplayName: 'Admin',
  ...extra,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UserManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  superAdmin = true;
  updateUser.mockResolvedValue(adminUser({ emailLinkEligible: true }));
});

describe('Users page — confirm an email for SSO linking', () => {
  it('re-saves the address unchanged when a Super Admin confirms it', async () => {
    getUsers.mockResolvedValue([adminUser({ emailLinkEligible: false })]);

    renderPage();

    expect(await screen.findByText('Email not confirmed for SSO')).toBeTruthy();
    await userEvent.click(screen.getByTitle('Confirm email for SSO'));

    // The dialog names the address, so the actor can see what they confirm.
    expect(await screen.findByText(/Confirm mara@example\.com as mara's address\?/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm email' }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith(7, { email: 'mara@example.com' }));
  });

  it('keeps the dialog open when the confirmation fails', async () => {
    // A 403 or a lost connection must not read as "confirmed" — the row is
    // still unconfirmed, and the actor needs the dialog to retry from.
    getUsers.mockResolvedValue([adminUser({ emailLinkEligible: false })]);
    updateUser.mockRejectedValue(new Error('Forbidden'));

    renderPage();

    await userEvent.click(await screen.findByTitle('Confirm email for SSO'));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm email' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Confirm email' })).toBeTruthy();
  });

  it('shows the server\'s reason when the address changed under the dialog', async () => {
    // The 409 from the conditional confirm write. useMutationWithToast only
    // reads response.data.error when errorMessage is a string — a function
    // would show axios's own "Request failed with status code 409".
    const serverMessage = 'The email address changed while this was open — reload and try again';
    getUsers.mockResolvedValue([adminUser({ emailLinkEligible: false })]);
    updateUser.mockRejectedValue(Object.assign(new Error('Request failed with status code 409'), {
      response: { status: 409, data: { error: serverMessage } },
    }));

    renderPage();

    await userEvent.click(await screen.findByTitle('Confirm email for SSO'));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm email' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(serverMessage));
  });

  it('falls back to the translated message when the server sends none', async () => {
    getUsers.mockResolvedValue([adminUser({ emailLinkEligible: false })]);
    updateUser.mockRejectedValue(new Error('Network Error'));

    renderPage();

    await userEvent.click(await screen.findByTitle('Confirm email for SSO'));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm email' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to confirm the email'));
  });

  it('offers nothing on a row whose email is already confirmed', async () => {
    getUsers.mockResolvedValue([adminUser({ emailLinkEligible: true })]);

    renderPage();

    await screen.findByText('mara');
    expect(screen.queryByTitle('Confirm email for SSO')).toBeNull();
    expect(screen.queryByText('Email not confirmed for SSO')).toBeNull();
  });

  it('offers nothing on a backend that predates the column', async () => {
    // emailLinkEligible undefined — the flag travels only after migration 227.
    getUsers.mockResolvedValue([adminUser()]);

    renderPage();

    await screen.findByText('mara');
    expect(screen.queryByTitle('Confirm email for SSO')).toBeNull();
  });

  it('hides the action from an admin who is not a Super Admin', async () => {
    // Only a super_admin actor sets the flag; anyone else would get a 403.
    superAdmin = false;
    getUsers.mockResolvedValue([adminUser({ emailLinkEligible: false })]);

    renderPage();

    await screen.findByText('mara');
    expect(screen.queryByTitle('Confirm email for SSO')).toBeNull();
    expect(screen.queryByText('Email not confirmed for SSO')).toBeNull();
  });
});
