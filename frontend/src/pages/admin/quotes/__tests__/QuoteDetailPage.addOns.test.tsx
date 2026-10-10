/**
 * Quote detail → add-ons of an accepted quote (#1451): the admin books or
 * removes add-ons and saves after a confirm (the customer is emailed); the
 * customer's message and the change history are shown; once a contract,
 * event or invoice exists the add-ons are read-only with a hint.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ConfirmDialogProvider } from '../../../../components/common/ConfirmDialog';
import { formatMoneyMinor } from '../../../../utils/money';

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

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('react-toastify', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));
vi.mock('../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../../../components/admin/DocumentLineageCard', () => ({ DocumentLineageCard: () => null }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
// A draft's page is its editor; the form itself has its own tests.
vi.mock('../QuoteEditorPage', () => ({ QuoteForm: () => <div>Quote form</div> }));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: (d: string) => String(d),
    formatDateTime: (d: string) => String(d),
    formatTime: (d: string) => String(d),
  }),
}));
vi.mock('../../../../services/quoteCatalog.service', () => ({ quoteCatalogService: {} }));

const get = vi.fn();
const changeAddOns = vi.fn();
const reissue = vi.fn();
vi.mock('../../../../services/quotes.service', () => ({
  quotesService: {
    get: (...args: unknown[]) => get(...args),
    changeAddOns: (...args: unknown[]) => changeAddOns(...args),
    reissue: (...args: unknown[]) => reissue(...args),
  },
}));

import { QuoteDetailPage } from '../QuoteDetailPage';

const line = (id: number, position: number, description: string, lineTotalMinor: number, extra: Record<string, unknown> = {}) => ({
  id, position, quantity: 1, description, unitPriceMinor: lineTotalMinor, discountPercent: 0, lineTotalMinor,
  parentLineItemId: null, parentPosition: null, detailsText: null, lineKind: 'item', unit: null,
  isOptional: false, selected: true, ...extra,
});

const lineItems = [
  line(11, 1, 'Wedding day', 100000),
  line(12, 2, 'Album', 30000, { isOptional: true, selected: false, detailsText: '30 pages, linen cover' }),
  line(13, 3, 'Drone', 20000, { isOptional: true, selected: true }),
];

const quote = {
  id: 7, quoteNumber: 'Q-2026-0007', dealUuid: null, customerAccountId: 3, projectId: null,
  customer: { email: 'anna@example.com', displayName: 'Anna Muster', firstName: 'Anna', lastName: 'Muster', companyName: null },
  status: 'accepted', language: 'en', currency: 'CHF', issueDate: '2026-09-01', validUntil: null,
  eventName: 'Wedding', eventDate: null, eventType: null, bookingWorkflowId: null,
  netAmountMinor: 120000, vatRate: 0, vatAmountMinor: 0, shippingAmountMinor: 0, totalAmountMinor: 120000,
  sentAt: '2026-09-01T09:00:00Z', acceptedAt: '2026-09-01T10:00:00Z', declinedAt: null, declineReason: null,
  respondedAt: '2026-09-01T10:00:00Z', responseLockedAt: '2026-09-01T10:15:00Z',
  convertedEventId: null, convertedContractId: null, internalNotes: null, createdAt: '2026-09-01T08:00:00Z',
  selectionAcceptedAt: '2026-09-01T10:00:00Z',
  optionalSelection: {
    by: 'customer', selectedOptional: [3],
    addOns: [{ position: 2, description: 'Album', selected: false }, { position: 3, description: 'Drone', selected: true }],
    netAmountMinor: 120000, vatAmountMinor: 0, totalAmountMinor: 120000,
  },
  customerMessage: null,
  selectionChanges: [],
  addOnsEditable: true,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={['/admin/clients/quotes/7']}>
          <Routes>
            <Route path="/admin/clients/quotes/:id" element={<><QuoteDetailPage /><Where /></>} />
          </Routes>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

async function findAddOnsCard() {
  const heading = await screen.findByRole('heading', { name: 'Add-ons at acceptance' });
  return heading.parentElement as HTMLElement;
}

const addOnRow = (card: HTMLElement, description: string) =>
  within(card).getByText(description).closest('li') as HTMLElement;

const normalise = (s: string) => s.replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ quote, lineItems });
  changeAddOns.mockResolvedValue({ changed: true, totalAmountMinor: 150000, quote, lineItems });
});

it('says why an accepted quote can\'t be edited and how to change it', async () => {
  const user = userEvent.setup();
  renderPage();
  await findAddOnsCard();
  // No editor on an accepted quote: the page is read-only and says why.
  expect(screen.queryByText('Quote form')).toBeNull();
  expect(screen.getByText(/reissue it/)).toBeInTheDocument();
  // Both ways out are on the page: reissuing it, or declining it.
  expect(screen.getByRole('button', { name: 'Reissue' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  expect(screen.getByRole('menuitem', { name: 'Decline on behalf' })).toBeInTheDocument();
});

it('is the editor while the quote is a draft', async () => {
  get.mockResolvedValue({
    quote: { ...quote, status: 'draft', acceptedAt: null, optionalSelection: null, addOnsEditable: false },
    lineItems,
  });
  renderPage();
  expect(await screen.findByText('Quote form')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reissue' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('reissues an accepted quote and opens the new draft', async () => {
  const user = userEvent.setup();
  reissue.mockResolvedValue({ quoteId: 8 });
  renderPage();
  await findAddOnsCard();
  await user.click(screen.getByRole('button', { name: 'Reissue' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reissue' });
  await user.type(within(dialog).getByRole('textbox'), 'Kunde möchte ein grösseres Album');
  await user.click(within(dialog).getByRole('button', { name: 'Reissue' }));
  expect(reissue).toHaveBeenCalledWith(7, 'Kunde möchte ein grösseres Album');
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin/clients/quotes/8'));
});

it('books an add-on and saves it after the confirm', async () => {
  const user = userEvent.setup();
  renderPage();

  const card = await findAddOnsCard();
  const save = within(card).getByRole('button', { name: 'Save add-on changes' });
  expect(save).toBeDisabled();
  // Title, then details, then the status with the button as the last line.
  expect(addOnRow(card, 'Album').textContent).toMatch(/Album.*30 pages, linen cover.*Not booked.*Book$/);

  await user.click(within(addOnRow(card, 'Album')).getByRole('button', { name: 'Book' }));
  expect(within(addOnRow(card, 'Album')).getByRole('button', { name: 'Remove booking' })).toBeInTheDocument();
  expect(save).toBeEnabled();

  // Cancelled confirm: nothing is sent.
  await user.click(save);
  expect(await screen.findByText('The customer will be emailed the updated quote.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(changeAddOns).not.toHaveBeenCalled();

  await user.click(save);
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save add-on changes' }));
  await waitFor(() => expect(changeAddOns).toHaveBeenCalledWith(7, [2, 3]));
  await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(
    'Add-ons updated. The customer has been emailed the updated quote.',
  ));
  // The quote is refreshed from the server.
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
});

it('shows the customer message and the change history, newest first', async () => {
  get.mockResolvedValue({
    quote: {
      ...quote,
      customerMessage: 'Can we add\nan extra hour?',
      selectionChanges: [
        { at: '2026-09-01T10:05:00Z', by: 'customer', adminId: null, booked: ['Album'], removed: [], totalBeforeMinor: 120000, totalAfterMinor: 150000 },
        { at: '2026-09-02T08:00:00Z', by: 'admin', adminId: 1, booked: [], removed: ['Album'], totalBeforeMinor: 150000, totalAfterMinor: 120000 },
      ],
    },
    lineItems,
  });
  renderPage();

  expect(await screen.findByRole('heading', { name: 'Message from the customer' })).toBeInTheDocument();
  expect(screen.getByText('Can we add an extra hour?').textContent).toBe('Can we add\nan extra hour?');

  expect(screen.getByRole('heading', { name: 'Changes' })).toBeInTheDocument();
  const who = screen.getAllByText(/by (the customer|you)$/).map((el) => el.textContent);
  expect(who).toEqual(['2026-09-02T08:00:00Z · by you', '2026-09-01T10:05:00Z · by the customer']);
  expect(screen.getByText('Booked: Album')).toBeInTheDocument();
  expect(screen.getByText('Removed: Album')).toBeInTheDocument();
  expect(screen.getByText(normalise(
    `Total ${formatMoneyMinor(120000, 'CHF')} → ${formatMoneyMinor(150000, 'CHF')}`,
  ))).toBeInTheDocument();
});

it('keeps the add-ons read-only once the quote is converted', async () => {
  get.mockResolvedValue({
    quote: { ...quote, status: 'converted', convertedEventId: 5, addOnsEditable: false },
    lineItems,
  });
  renderPage();

  const card = await findAddOnsCard();
  expect(within(card).getByText('Change the add-ons on the contract or invoice.')).toBeInTheDocument();
  expect(within(card).queryByRole('button', { name: /^(Book|Remove booking|Save add-on changes)$/ })).toBeNull();
  expect(within(addOnRow(card, 'Album')).getByText('Not booked')).toBeInTheDocument();
  expect(within(addOnRow(card, 'Drone')).getByText('Booked')).toBeInTheDocument();
});
