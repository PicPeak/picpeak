/**
 * The CRM behaviour tab's subtitle names what the tab configures on this
 * install. A documents-only install used to read "Fine-tune quote and invoice
 * behaviour" above a page with neither.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const t = (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
    const text = typeof fb === 'string' ? fb : k;
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''));
  };
  return { ...actual, useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

const flagsState = { flags: {} as Record<string, boolean>, isLoading: false };
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => flagsState,
  useFeatureEnabled: () => false,
}));

vi.mock('../../../../services/settings.service', () => ({
  settingsService: { getAllSettings: vi.fn(async () => ({})), updateSettings: vi.fn() },
}));
vi.mock('../../../../services/quotes.service', () => ({
  quotesService: { listPaymentNetDaysTemplates: vi.fn(async () => ({ templates: [] })), listPaymentTimingTemplates: vi.fn(async () => ({ templates: [] })) },
}));

import { CrmSettingsPage } from '../CrmSettingsPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CrmSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CrmSettingsPage subtitle', () => {
  beforeEach(() => { flagsState.flags = {}; });

  it('names only customer documents on a documents-only install', async () => {
    flagsState.flags = { documents: true };
    renderPage();
    expect(await screen.findByText('Settings for customer documents.')).toBeInTheDocument();
    expect(screen.queryByText(/quote and invoice/)).not.toBeInTheDocument();
  });

  it('lists every enabled area', async () => {
    flagsState.flags = { quotes: true, bills: true, documents: true };
    renderPage();
    expect(await screen.findByText('Settings for quotes, invoices, and customer documents.')).toBeInTheDocument();
  });
});
