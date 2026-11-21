/**
 * A restore that replaced the database signs the admin out. Signing in again
 * in the same tab goes back to the restore tab, where the wizard shows that
 * run's result, instead of the dashboard.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../contexts', () => ({ useAdminAuth: () => ({ isAuthenticated: true, login: vi.fn() }) }));
vi.mock('../../../contexts/AdminDarkModeContext', () => ({ useAdminDarkMode: () => ({ isDark: false }) }));
vi.mock('../../../services/setup.service', () => ({
  setupService: { getSetupStatus: vi.fn().mockResolvedValue({ needsAdmin: false }) },
}));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: {} }) }));

import { AdminLoginPage } from '../AdminLoginPage';

const Where = () => {
  const location = useLocation();
  return <p>{`at ${location.pathname}${location.search}`}</p>;
};

const renderLogin = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/admin/login']}>
      <Routes>
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe('AdminLoginPage after a restore sign-out', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it('goes to the dashboard normally', () => {
    renderLogin();
    expect(screen.getByText('at /admin/dashboard')).toBeTruthy();
  });

  const track = (extra: Record<string, unknown> = {}) => sessionStorage.setItem('picpeak_restore_run',
    JSON.stringify({ runStartedAt: '2026-11-20T10:00:00.000Z', since: Date.now(), signedOut: true, ...extra }));

  it('goes back to the restore tab while a restore is tracked', () => {
    track();
    renderLogin();
    expect(screen.getByText('at /admin/settings?tab=backup&backupTab=restore')).toBeTruthy();
  });

  it('follows the marker once: the next sign-in goes to the dashboard', () => {
    // E.g. the restored account may not open the restore tab, so nothing
    // there re-arms the redirect.
    track();
    renderLogin();
    expect(screen.getByText('at /admin/settings?tab=backup&backupTab=restore')).toBeTruthy();
    cleanup();
    renderLogin();
    expect(screen.getByText('at /admin/dashboard')).toBeTruthy();
  });

  it('ignores a marker older than two hours', () => {
    track({ since: Date.now() - 2 * 60 * 60 * 1000 - 1000 });
    renderLogin();
    expect(screen.getByText('at /admin/dashboard')).toBeTruthy();
    expect(sessionStorage.getItem('picpeak_restore_run')).toBeNull();
  });
});
