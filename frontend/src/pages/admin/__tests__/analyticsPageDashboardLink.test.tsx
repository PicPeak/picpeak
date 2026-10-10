/**
 * The shipped nginx CSP only allows `frame-src 'self' https://www.google.com`,
 * so an embedded external dashboard renders blank unless the operator adds its
 * origin. The page therefore leads with a new-tab link, keeps the embed as an
 * extra with a visible hint, and reads its state from the settings only.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const apiGet = vi.fn();
vi.mock('../../../config/api', () => ({ api: { get: (...args: unknown[]) => apiGet(...args) } }));
vi.mock('../../../services/admin.service', () => ({
  adminService: {
    getAnalytics: async () => ({
      chartData: [], topGalleries: [], devices: { desktop: 0, mobile: 0, tablet: 0 },
      totals: { views: 0, uniqueVisitors: 0, downloads: 0 },
    }),
    getDashboardStats: async () => null,
    formatBytes: (n: number) => String(n),
  },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getStorageInfo: async () => null },
}));

import { AnalyticsPage } from '../AnalyticsPage';

const SHARE = 'https://collector.example/share/private-link';
const configured = (overrides: Record<string, unknown> = {}) => ({
  analytics_umami_enabled: true,
  analytics_umami_url: 'https://collector.example',
  analytics_umami_website_id: 'site-1',
  analytics_umami_share_url: SHARE,
  analytics_dashboard_cookie_domain: null,
  ...overrides,
});
const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AnalyticsPage />
  </QueryClientProvider>,
);
const supportCredentialless = () => Object.defineProperty(
  HTMLIFrameElement.prototype, 'credentialless', { configurable: true, writable: true, value: false },
);

beforeEach(() => { apiGet.mockReset(); });
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(HTMLIFrameElement.prototype, 'credentialless');
});

describe('AnalyticsPage external dashboard', () => {
  it('offers the dashboard in a new tab even where it cannot be embedded', async () => {
    apiGet.mockResolvedValue({ data: configured() });
    const view = show();
    const link = await screen.findByRole('link', { name: 'analytics.openDashboard' });
    expect(link).toHaveAttribute('href', SHARE);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('button', { name: 'analytics.fullDashboard' })).toBeNull();
    expect(screen.queryByText('analytics.embedCspHint')).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
  });

  it('keeps the embed as an extra, with the frame-src hint before and beside the frame', async () => {
    supportCredentialless();
    apiGet.mockResolvedValue({ data: configured() });
    const view = show();
    const embed = await screen.findByRole('button', { name: 'analytics.fullDashboard' });
    expect(screen.getByText('analytics.embedCspHint')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'analytics.openDashboard' })).toHaveAttribute('href', SHARE);
    fireEvent.click(embed);
    expect(view.container.querySelector('iframe')).toHaveAttribute('src', SHARE);
    expect(screen.getByText('analytics.embedCspHint')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'analytics.openDashboard' })).toHaveAttribute('href', SHARE);
  });

  it('links no dashboard inside the application cookie scope', async () => {
    supportCredentialless();
    apiGet.mockResolvedValue({ data: configured({ analytics_dashboard_cookie_domain: '.collector.example' }) });
    show();
    expect(await screen.findByText('analytics.embedUnavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'analytics.openDashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'analytics.fullDashboard' })).toBeNull();
  });

  it.each([
    ['unconfigured settings', () => apiGet.mockResolvedValue({ data: {} })],
    ['a failed settings request', () => apiGet.mockRejectedValue(new Error('403'))],
  ])('ignores build-time VITE_UMAMI_* values with %s', async (_label, arrange) => {
    vi.stubEnv('VITE_UMAMI_URL', 'https://env.example');
    vi.stubEnv('VITE_UMAMI_WEBSITE_ID', 'env-site');
    vi.stubEnv('VITE_UMAMI_SHARE_URL', 'https://env.example/share/from-env');
    supportCredentialless();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    arrange();
    const view = show();
    expect(await screen.findByText('analytics.notConfigured')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'analytics.openDashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'analytics.fullDashboard' })).toBeNull();
    expect(view.container.innerHTML).not.toContain('env.example');
  });
});
