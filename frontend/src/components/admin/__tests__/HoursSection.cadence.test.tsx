/**
 * Admin → hours card, by billing cadence.
 *
 * Monthly and manual customers are accumulators: every entry is appended to
 * the running draft, and the server refuses "Bill these hours" for them
 * (409 CADENCE_MISMATCH). The card must not offer that button to either,
 * and the hint must name the draft the entries really land on.
 */
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = typeof fb === 'string' ? fb : k;
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        return vars ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? '')) : base;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: () => true, hasAnyPermission: () => true, hasAllPermissions: () => true, isSuperAdmin: true,
  }),
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { incomingInvoices: false, projects: false } }),
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => d, formatTime: (d: string) => d, formatDateTime: (d: string) => d }),
}));
vi.mock('../../../services/businessProfile.service', () => ({
  businessProfileService: { get: vi.fn(async () => ({ profile: { defaultCurrency: 'CHF', defaultHourlyRateMinor: null } })) },
}));
vi.mock('../../../services/accounting.service', () => ({
  accountingService: { listCustomerRebills: vi.fn(async () => []) },
}));
vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: {
    listHourEntries: vi.fn(async () => [{
      id: 1,
      entryDate: '2026-11-20',
      startTime: '09:00',
      endTime: '10:00',
      durationMinutes: 60,
      hourlyRateMinorOverride: null,
      description: 'Editing',
      status: 'unbilled',
      invoiceId: null,
      invoiceNumber: null,
      invoiceStatus: null,
      invoiceIsMonthlyDraft: false,
      invoiceScheduledSendAt: null,
    }]),
    createHourEntry: vi.fn(),
    deleteHourEntry: vi.fn(),
    billUnbilledHourEntries: vi.fn(),
    billCombined: vi.fn(),
  },
}));

import { HoursSection } from '../HoursSection';

function renderSection(billingCadence: 'per_event' | 'monthly' | 'quarterly' | 'manual') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HoursSection customerId={7} customerHourlyRateMinor={15000} billingCadence={billingCadence} compact />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HoursSection by billing cadence', () => {
  it('offers "Create draft invoice" to a per-event customer', async () => {
    renderSection('per_event');
    expect(await screen.findByRole('button', { name: 'Create draft invoice' })).toBeInTheDocument();
    expect(screen.getByText(/stay unbilled until you click/)).toBeInTheDocument();
  });

  it('shows a manual customer the manual-draft hint and no bill button', async () => {
    renderSection('manual');
    expect(await screen.findByText('Editing')).toBeInTheDocument();
    expect(screen.getByText(/auto-append to the running manual draft/)).toBeInTheDocument();
    expect(screen.queryByText(/stay unbilled until you click/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).not.toBeInTheDocument();
  });

  it('keeps the monthly hint and no bill button for a monthly customer', async () => {
    renderSection('monthly');
    expect(await screen.findByText('Editing')).toBeInTheDocument();
    expect(screen.getByText(/auto-append to the current monthly draft/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).not.toBeInTheDocument();
  });
});
