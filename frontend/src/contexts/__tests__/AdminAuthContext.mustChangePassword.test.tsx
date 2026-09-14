/**
 * A flagged admin who arrives on a fresh page load (a reload, or the gallery
 * preview's "Go to admin area" link) never goes through login(), so the
 * must-change-password flag has to come from the /auth/session payload or
 * AdminLayout shows no password-change dialog.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const get = vi.fn();
vi.mock('../../config/api', () => ({
  api: { get: (...args: any[]) => get(...args) },
}));
vi.mock('../../services', () => ({
  authService: { adminLogout: vi.fn() },
}));

import { AdminAuthProvider, useAdminAuth } from '../AdminAuthContext';

function renderAuth() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AdminAuthProvider>{children}</AdminAuthProvider>
  );
  return renderHook(() => useAdminAuth(), { wrapper });
}

function session(mustChangePassword: boolean) {
  return {
    data: {
      valid: true,
      type: 'admin',
      adminUser: { id: 1, username: 'admin', email: 'a@example.com', mustChangePassword, role: null },
    },
  };
}

describe('AdminAuthProvider session hydration', () => {
  beforeEach(() => {
    get.mockReset();
    sessionStorage.clear();
  });

  it('restores the must-change-password flag from the session', async () => {
    get.mockResolvedValue(session(true));
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.mustChangePassword).toBe(true);
  });

  it('leaves the flag off for an admin who does not need a change', async () => {
    get.mockResolvedValue(session(false));
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.mustChangePassword).toBe(false);
  });
});
