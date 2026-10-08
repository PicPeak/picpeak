/**
 * The tax report covers every invoice of the studio, so the server refuses it
 * (403, CRM_COMPLETE_VIEW_REQUIRED) for an account that only sees its own
 * documents. The page used to show that as axios' "Request failed with status
 * code 403"; it has to say why the report is not available.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getReport = vi.fn();
vi.mock('../../../../services/taxReport.service', () => ({ taxReportService: { getReport: (...args: unknown[]) => getReport(...args) } }));
vi.mock('../../../../services/ledger.service', () => ({ ledgerService: {} }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: (value: string) => value }) }));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { accounting: true, taxReport: true, bills: true } }),
}));

import { TaxReportPage } from '../TaxReportPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><TaxReportPage /></MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TaxReportPage when the report is refused', () => {
  it('explains that the account does not see every invoice', async () => {
    getReport.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { code: 'CRM_COMPLETE_VIEW_REQUIRED' } },
    }));
    renderPage();
    expect(await screen.findByText(/only sees its own documents/)).toBeInTheDocument();
    expect(screen.queryByText(/status code 403/)).not.toBeInTheDocument();
  });

  it('keeps showing the raw message for any other failure', async () => {
    getReport.mockRejectedValueOnce(new Error('Network Error'));
    renderPage();
    expect(await screen.findByText('Network Error')).toBeInTheDocument();
  });
});
