/**
 * A database restore ends the admin's session. When the tab reloads before
 * any admin request sees the 401, the provider finds out through
 * /auth/session; a restore tracked in this tab must still count as having
 * signed the admin out, so an SSO sign-in (which lands on the dashboard)
 * goes on to its result.
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
import { readRestoreRun, rememberRestoreRun } from '../../utils/restoreRelogin';

function renderAuth() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AdminAuthProvider>{children}</AdminAuthProvider>
  );
  return renderHook(() => useAdminAuth(), { wrapper });
}

describe('AdminAuthProvider and a tracked restore', () => {
  beforeEach(() => {
    get.mockReset();
    sessionStorage.clear();
  });

  it('marks the tracked restore as having signed the admin out when the session is gone', async () => {
    rememberRestoreRun({ runStartedAt: '2026-11-20T10:00:00.000Z', since: Date.now() });
    get.mockResolvedValue({ data: { valid: false } });
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(readRestoreRun()?.signedOut).toBe(true);
  });

  it('leaves no marker behind when no restore is tracked', async () => {
    get.mockResolvedValue({ data: { valid: false } });
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(readRestoreRun()).toBeNull();
  });
});
