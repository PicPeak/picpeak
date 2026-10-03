/**
 * The admin login footer used to fall back to `support@example.com` when
 * Branding had no support email — publicSettings returns '' until one is
 * set, so every unbranded install showed visitors a placeholder address.
 * The help line now renders only with a configured address.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../contexts', () => ({
  useAdminAuth: () => ({ isAuthenticated: false, login: vi.fn() }),
}));

vi.mock('../../../contexts/AdminDarkModeContext', () => ({
  useAdminDarkMode: () => ({ isDark: false }),
}));

vi.mock('../../../services/setup.service', () => ({
  setupService: { getSetupStatus: vi.fn().mockResolvedValue({ needsAdmin: false }) },
}));

let supportEmail = '';
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({
    data: { branding_support_email: supportEmail, branding_hide_powered_by: true },
  }),
}));

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

describe('AdminLoginPage support contact', () => {
  it('links the configured support address', () => {
    supportEmail = 'help@studio.example';
    const { container } = renderPage();

    const link = screen.getByRole('link', { name: 'help@studio.example' });
    expect(link).toHaveAttribute('href', 'mailto:help@studio.example');
    expect(container.textContent).toContain('adminLogin.needHelp');
  });

  it('omits the whole help line when no support address is configured', () => {
    supportEmail = '';
    const { container } = renderPage();

    expect(container.textContent).not.toContain('support@example.com');
    expect(container.textContent).not.toContain('adminLogin.needHelp');
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});
