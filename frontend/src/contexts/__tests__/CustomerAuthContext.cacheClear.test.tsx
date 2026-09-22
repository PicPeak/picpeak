/**
 * Customer portal cache-clear on logout/session-loss (#1594).
 *
 * The customer portal's React Query keys aren't scoped to the account, and
 * the QueryClient is a single instance shared across the whole app (see
 * App.tsx). Losing a session (401) doesn't hard-navigate — the SPA stays
 * mounted — so without clearing the query cache, the next customer signing
 * in on the same device/tab can briefly render the previous customer's
 * cached dashboard before their own data arrives.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { CustomerDashboard, CustomerProfile } from '../../services/customer.service';

// Resolve against the real en.json, same convention as
// pages/customer/__tests__/customerDocuments.test.tsx, so a missing key
// shows up as a failing label instead of a silent fallback.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = lookup(k) ?? (typeof fb === 'string' ? fb : k);
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        if (!vars) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: (d: string) => String(d).slice(0, 10),
    formatDateTime: (d: string) => String(d),
  }),
}));

// CustomerAuthContext talks to i18n/config directly (not via the
// react-i18next hook above) to apply the customer's preferred language.
// Stub it out so the real HttpBackend/LanguageDetector init never runs.
vi.mock('../../i18n/config', () => ({
  default: { language: 'en', changeLanguage: vi.fn(() => Promise.resolve()) },
}));

const sessionSpy = vi.fn();
const dashboardSpy = vi.fn();

vi.mock('../../services/customer.service', () => ({
  customerService: {
    session: (...a: unknown[]) => sessionSpy(...a),
    logout: vi.fn(async () => undefined),
    getDashboard: (...a: unknown[]) => dashboardSpy(...a),
  },
  DEFAULT_CUSTOMER_FEATURES: {
    calendar: false, quotes: false, bills: false, contracts: false, documents: false,
  },
}));

import { CustomerAuthProvider, useCustomerAuth } from '../CustomerAuthContext';
import { CustomerDashboardPage } from '../../pages/customer/CustomerDashboardPage';

const features = { calendar: false, quotes: false, bills: false, contracts: false, documents: false };
const branding = { showLogo: true, showCompanyName: true };

const customerA: CustomerProfile = {
  id: 1, email: 'a@example.com', displayName: 'Customer A', firstName: 'A', lastName: null, preferredLanguage: 'en',
};
const customerB: CustomerProfile = {
  id: 2, email: 'b@example.com', displayName: 'Customer B', firstName: 'B', lastName: null, preferredLanguage: 'en',
};

function dashboardWith(eventName: string): CustomerDashboard {
  return {
    needsAction: { quotes: [], contracts: [], invoices: [] },
    galleries: {
      active: [{
        id: 1, slug: 'evt', eventName, eventType: 'wedding', eventDate: '2026-01-01',
        expiresAt: null, isActive: true, assignedAt: '2026-01-01', availability: 'active',
      }],
      expired: [],
    },
  };
}

/** Mirrors CustomerLayout's own gate: no dashboard mounted while logged out. */
function TestApp() {
  const { isAuthenticated, isLoading } = useCustomerAuth();
  if (isLoading) return <div>auth-loading</div>;
  if (!isAuthenticated) return <div>login-page</div>;
  return <CustomerDashboardPage />;
}

function renderApp(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CustomerAuthProvider>
          <TestApp />
        </CustomerAuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('customer portal query cache clears on session loss (#1594)', () => {
  beforeEach(() => {
    sessionSpy.mockReset();
    dashboardSpy.mockReset();
    sessionStorage.clear();
  });

  it('drops the cached dashboard when the session is revoked, so the next customer never sees it', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // Customer A is signed in; the dashboard query populates the cache.
    sessionSpy.mockResolvedValue({ customer: customerA, features, branding });
    dashboardSpy.mockResolvedValue(dashboardWith('Alpha Wedding'));
    renderApp(qc);

    expect(await screen.findByText('Alpha Wedding')).toBeInTheDocument();
    expect(qc.getQueryData(['customer-dashboard'])).toBeTruthy();

    // Session gets revoked server-side (401) — e.g. sign-out elsewhere, an
    // erasure-forced logout, or the session simply expiring. This path
    // never hard-navigates, so the SPA (and its QueryClient) stays mounted.
    sessionSpy.mockResolvedValue(null);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByText('login-page')).toBeInTheDocument());

    // The regression: without clearing the cache here, Customer A's
    // dashboard data would still sit under ['customer-dashboard'].
    expect(qc.getQueryData(['customer-dashboard'])).toBeUndefined();

    // Customer B signs in on the same tab/device.
    sessionSpy.mockResolvedValue({ customer: customerB, features, branding });
    dashboardSpy.mockResolvedValue(dashboardWith('Beta Shoot'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText('Beta Shoot')).toBeInTheDocument();
    // At no point should Customer A's gallery have rendered for Customer B.
    expect(screen.queryByText('Alpha Wedding')).not.toBeInTheDocument();
  });
});
