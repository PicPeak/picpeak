/**
 * Send on the contract detail page (#1445 × #1446): Send opens the pre-send
 * review, and collect-then-freeze is chosen there — the review sends with
 * `collectData: true`. A contract already waiting for the customer's details
 * finishes its send directly: the review (a draft's) is never asked for.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en,
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

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../../../components/admin/DocumentLineageCard', () => ({ DocumentLineageCard: () => null }));
vi.mock('../SigningOverviewCard', () => ({ SigningOverviewCard: () => null }));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }),
}));
vi.mock('../../../../services/quotes.service', () => ({ quotesService: { get: vi.fn() } }));
vi.mock('../../../../services/bills.service', () => ({ billsService: { list: vi.fn(async () => ({ invoices: [] })) } }));

const get = vi.fn();
const send = vi.fn();
const sendPreview = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return {
    ...actual,
    contractsService: {
      get: (...args: unknown[]) => get(...args),
      send: (...args: unknown[]) => send(...args),
      sendPreview: (...args: unknown[]) => sendPreview(...args),
      documents: vi.fn(async () => ({ documents: [] })),
      signers: vi.fn(async () => ({ version: 2, signers: [], events: [] })),
      auditTrail: vi.fn(async () => ({ events: [] })),
      verifyIntegrity: vi.fn(),
    },
  };
});

import { ContractDetailPage } from '../ContractDetailPage';

const contract = (extra: Record<string, unknown>) => ({
  contract: {
    id: 7, contractNumber: 'C-2026-0007', title: 'Wedding contract', status: 'draft', language: 'en',
    customerAccountId: 3, sourceQuoteId: null, pdfPath: null, signedPdfPath: null,
    customer: { email: 'anna@example.com', displayName: 'Anna Muster', firstName: 'Anna', lastName: 'Muster', companyName: null },
    inclusions: [], textSections: [], attachments: [], ...extra,
  },
});

const review = {
  content: {
    contractNumber: 'C-2026-0007', language: 'en', title: 'Wedding contract', introText: null, outroText: null,
    recipient: { displayName: 'Anna Muster', companyName: null, email: 'anna@example.com' },
    sections: [], commercial: null,
  },
  signingOrder: 'parallel',
  signers: [
    { position: 1, role: 'customer', name: 'Anna Muster', email: 'anna@example.com' },
    { position: 2, role: 'issuer', name: 'Studio', email: null },
  ],
  attachments: [],
  totals: { currency: 'CHF', netMinor: 100000, vatRatePercent: 0, vatMinor: 0, shippingMinor: 0, grossMinor: 100000 },
  template: null,
  problems: [],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/clients/contracts/7']}>
        <Routes>
          <Route path="/admin/clients/contracts/:id" element={<ContractDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sendPreview.mockResolvedValue(review);
  send.mockResolvedValue({ token: 'x', pdfPath: null });
});

it('Send opens the review, and asking for the details there sends with collectData', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(contract({ customerAddressMissing: true }));
  renderPage();
  // The option lives in the review now, not beside the Send button.
  await user.click(await screen.findByRole('button', { name: 'Send to customer' }));
  expect(send).not.toHaveBeenCalled();
  await screen.findByRole('dialog', { name: 'Review before sending' });
  await user.click(await screen.findByRole('checkbox', { name: 'Ask the customer to complete their details first' }));
  await user.click(screen.getByRole('button', { name: 'Ask for the details' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(7, { collectData: true }));
});

it('a plain send from the review does not collect', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(contract({ customerAddressMissing: true }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Send to customer' }));
  await user.click(await screen.findByRole('button', { name: 'Send to 1 signers' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(7, { collectData: false }));
});

it('an awaiting_data contract with the details in finishes its send without the review', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(contract({ status: 'awaiting_data', dataCollectedAt: '2026-09-22T10:00:00Z' }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: "Finish sending with the customer's details" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(7, { collectData: false }));
  expect(sendPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: 'Review before sending' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
});

it('an awaiting_data contract still waiting offers no send at all', async () => {
  get.mockResolvedValue(contract({ status: 'awaiting_data', dataCollectedAt: null }));
  renderPage();
  expect(await screen.findByText(/Waiting for the customer to complete their details/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
  expect(sendPreview).not.toHaveBeenCalled();
});
