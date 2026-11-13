/**
 * A user manager whose role does not cover an account's role is refused with
 * a 403 that says so. The Users page shows that reason instead of a generic
 * "Failed to ..." toast, and falls back to its own text when the server sends
 * none.
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
const deactivateUser = vi.fn();
const activateUser = vi.fn();
vi.mock('../../../services/userManagement.service', () => ({
  userManagementService: {
    getUsers: (...a: unknown[]) => getUsers(...a),
    getRoles: vi.fn().mockResolvedValue([]),
    getInvitations: vi.fn().mockResolvedValue([]),
    updateUser: (...a: unknown[]) => updateUser(...a),
    createInvitation: vi.fn(),
    cancelInvitation: vi.fn(),
    deactivateUser: (...a: unknown[]) => deactivateUser(...a),
    activateUser: (...a: unknown[]) => activateUser(...a),
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
  superAdmin = false;
});

const refusal = 'You can only change accounts whose role is within your own permissions';
const forbidden = () => Object.assign(new Error('Request failed with status code 403'), {
  response: { status: 403, data: { error: refusal } },
});

describe('Users page — refusals for accounts above the caller', () => {
  it('shows the server\'s reason when deactivating is refused', async () => {
    getUsers.mockResolvedValue([adminUser()]);
    deactivateUser.mockRejectedValue(forbidden());
    renderPage();
    await userEvent.click(await screen.findByTitle('userManagement.deactivateUser'));
    await userEvent.click(await screen.findByRole('button', { name: 'userManagement.deactivate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
  });

  it('shows the server\'s reason when reactivating is refused', async () => {
    getUsers.mockResolvedValue([adminUser({ isActive: false })]);
    activateUser.mockRejectedValue(forbidden());
    renderPage();
    await userEvent.click(await screen.findByTitle('Reactivate user'));
    await userEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
  });

  it('falls back to its own text when the server sends no reason', async () => {
    getUsers.mockResolvedValue([adminUser()]);
    deactivateUser.mockRejectedValue(new Error('Network Error'));
    renderPage();
    await userEvent.click(await screen.findByTitle('userManagement.deactivateUser'));
    await userEvent.click(await screen.findByRole('button', { name: 'userManagement.deactivate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('userManagement.deactivateUserError'));
  });
});
