/**
 * An imported contract (POST /contracts/import) keeps the uploaded PDF as
 * its record: the server answers 409 CONTRACT_IMPORTED to re-send,
 * re-stamp, counter-sign and signed-PDF upload, so the detail page does
 * not offer them. Downloading the PDF stays.
 */
import { render, screen } from '@testing-library/react';
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

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../../../components/admin/DocumentLineageCard', () => ({ DocumentLineageCard: () => null }));
vi.mock('../SigningOverviewCard', () => ({ SigningOverviewCard: () => null }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
// A draft's page is its editor; the form has its own tests.
vi.mock('../ContractEditorPage', () => ({ ContractForm: () => <div>Contract form</div> }));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }),
}));
vi.mock('../../../../services/quotes.service', () => ({ quotesService: { get: vi.fn() } }));
vi.mock('../../../../services/bills.service', () => ({ billsService: { list: vi.fn(async () => ({ invoices: [] })) } }));

// The re-stamp card draws on a canvas, which jsdom has no 2D context for.
vi.mock('signature_pad', () => ({
  default: class { clear() {} isEmpty() { return true; } toDataURL() { return ''; } off() {} on() {} },
}));

const get = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return {
    ...actual,
    contractsService: {
      get: (...args: unknown[]) => get(...args),
      documents: vi.fn(async () => ({ documents: [] })),
      // Legacy signing, where the re-stamp card would otherwise show for a
      // contract without signature images.
      signers: vi.fn(async () => ({ version: 1, signers: [], events: [] })),
      auditTrail: vi.fn(async () => ({ events: [] })),
      verifyIntegrity: vi.fn(),
    },
  };
});

import { ContractDetailPage } from '../ContractDetailPage';

const fullySigned = (extra: Record<string, unknown>) => ({
  contract: {
    id: 7, contractNumber: 'C-2026-0007', title: 'Wedding contract', status: 'fully_signed', language: 'en',
    customerAccountId: 3, sourceQuoteId: null,
    pdfPath: 'business-docs/contract/imports/2026/imported-1-abcdef01.pdf',
    signedPdfPath: 'business-docs/contract/imports/2026/imported-1-abcdef01.pdf',
    signedByCustomerAt: '2023-03-04T00:00:00.000Z', signedByAdminAt: '2023-03-05T00:00:00.000Z',
    signedCustomerSignaturePath: null, signedAdminSignaturePath: null,
    customer: { email: 'anna@example.com', displayName: 'Anna Muster', firstName: 'Anna', lastName: 'Muster', companyName: null },
    inclusions: [], textSections: [], attachments: [], ...extra,
  },
});

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

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});
beforeEach(() => vi.clearAllMocks());

it('offers re-send and re-stamp on a signed contract', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(fullySigned({ isImported: false }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  expect(screen.getByText('Re-stamp missing signatures')).toBeInTheDocument();
  expect(screen.getAllByText(/No signature image captured/)).toHaveLength(2);
  expect(screen.getByRole('menuitem', { name: 'Re-send signed PDF' })).toBeInTheDocument();
});

it('offers neither on an imported contract, but keeps the download', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(fullySigned({ isImported: true, importedAt: '2026-10-27T10:00:00Z' }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  expect(screen.getByRole('menuitem', { name: 'Download signed PDF' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Re-send signed PDF' })).not.toBeInTheDocument();
  expect(screen.queryByText('Re-stamp missing signatures')).not.toBeInTheDocument();
  // Nor a hint pointing at that card.
  expect(screen.queryByText(/No signature image captured/)).not.toBeInTheDocument();
});

it('offers no counter-signature or upload on an imported contract awaiting one', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(fullySigned({ isImported: true, status: 'signed_by_customer', signedByAdminAt: null }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  expect(screen.queryByRole('menuitem', { name: 'Upload signed PDF' })).not.toBeInTheDocument();
  expect(screen.queryByText('Counter-sign to make it binding')).not.toBeInTheDocument();
});
