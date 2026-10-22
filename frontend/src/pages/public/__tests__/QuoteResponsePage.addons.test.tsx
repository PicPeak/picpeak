/**
 * Public quote page — optional add-ons (#1451).
 *
 * The customer books or removes add-ons, the page shows the server's totals
 * for that choice, and accepting sends the choice with the total that was
 * shown, plus an optional message. While the response window is open an
 * accepted quote's add-ons can still be changed by accepting again; once it
 * has closed the choice is shown read-only.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
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
      i18n: { language: 'en', changeLanguage: vi.fn(async () => undefined) },
    }),
  };
});

vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => ({ isDark: false }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: (d: string) => String(d),
    formatDateTime: (d: string) => String(d),
    formatTime: (d: string) => String(d),
  }),
}));

const get = vi.fn();
const totals = vi.fn();
const respond = vi.fn();
vi.mock('../../../services/quotes.service', () => ({
  publicQuotesService: {
    get: (...args: unknown[]) => get(...args),
    totals: (...args: unknown[]) => totals(...args),
    respond: (...args: unknown[]) => respond(...args),
  },
}));

import { QuoteResponsePage } from '../QuoteResponsePage';

const line = (position: number, description: string, unitPriceMinor: number, extra: Record<string, unknown> = {}) => ({
  position, quantity: 1, description, unitPriceMinor, discountPercent: 0, lineTotalMinor: unitPriceMinor,
  parentLineItemId: null, parentPosition: null, detailsText: null, isOptional: false, selected: true, ...extra,
});

const quote = {
  quoteNumber: 'Q-2026-0001', status: 'sent', language: 'en', currency: 'CHF',
  issueDate: '2026-09-01', validUntil: null, eventName: null, eventDate: null,
  eventTimeStart: null, eventTimeEnd: null, introText: null, outroText: null,
  netAmountMinor: 120000, vatRate: 0, vatAmountMinor: 0, shippingAmountMinor: 0, totalAmountMinor: 120000,
  respondedAt: null, responseLockedAt: null, canRespond: true, selectionLocked: false, customerMessage: null,
  lineItems: [
    line(1, 'Wedding day', 100000),
    line(2, 'Album', 30000, { isOptional: true, selected: false, detailsText: '30 pages, linen cover' }),
    line(3, 'Drone', 20000, { isOptional: true, selected: true }),
  ],
  tos: { required: false, text: '', url: '', acceptedAt: null },
  recipient: null,
  issuer: null,
};

// The Book / Remove booking buttons in line order: [Album, Drone].
const addOnButtons = () => screen.getAllByRole('button', { name: /^(Book|Remove booking)$/ });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/quote/abc']}>
        <Routes><Route path="/quote/:token" element={<QuoteResponsePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ quote });
  totals.mockImplementation(async (_token: string, selected: number[]) => {
    const net = 100000 + (selected.includes(2) ? 30000 : 0) + (selected.includes(3) ? 20000 : 0);
    return {
      selectedOptional: selected, netAmountMinor: net, vatAmountMinor: 0,
      shippingAmountMinor: 0, totalAmountMinor: net, lines: [],
    };
  });
  respond.mockResolvedValue({ status: 'accepted', lockedAt: '2026-09-01T10:15:00Z' });
});

it('books and removes add-ons, recalculates, and accepts with the total shown and the message', async () => {
  const user = userEvent.setup();
  renderPage();

  await screen.findByText('Album');
  expect(addOnButtons().map((b) => b.textContent)).toEqual(['Book', 'Remove booking']);
  await waitFor(() => expect(totals).toHaveBeenCalledWith('abc', [3], null));
  // Title, then details, then the status with the button as the last line.
  const details = screen.getByText('30 pages, linen cover').closest('tr');
  expect(details?.nextElementSibling).toContainElement(addOnButtons()[0]);

  await user.click(addOnButtons()[0]);
  await waitFor(() => expect(totals).toHaveBeenCalledWith('abc', [2, 3], null));
  expect(addOnButtons()[0]).toHaveTextContent('Remove booking');

  await user.click(addOnButtons()[1]);
  await waitFor(() => expect(totals).toHaveBeenCalledWith('abc', [2], null));
  expect(addOnButtons()[1]).toHaveTextContent('Book');

  await user.type(screen.getByLabelText('Your message to us (optional)'), 'See you there');

  const accept = screen.getByRole('button', { name: /^accept/i });
  await waitFor(() => expect(accept).toBeEnabled());
  await user.click(accept);
  await waitFor(() => expect(respond).toHaveBeenCalledWith('abc', 'accept', expect.objectContaining({
    selectedOptional: [2], expectedTotalMinor: 130000, customerMessage: 'See you there',
  }), null));
});

it('lets the customer change the add-ons after accepting while the window is open', async () => {
  get.mockResolvedValue({
    quote: {
      ...quote, status: 'accepted', canRespond: true, selectionLocked: false,
      respondedAt: '2026-09-01T10:00:00Z', responseLockedAt: '2026-09-01T10:15:00Z',
      customerMessage: 'See you there',
    },
  });
  const user = userEvent.setup();
  renderPage();

  expect(await screen.findByText('Your message')).toBeInTheDocument();
  expect(screen.getByText('See you there')).toBeInTheDocument();
  expect(screen.getByText(/You can change your add-ons until 2026-09-01T10:15:00Z/)).toBeInTheDocument();
  await waitFor(() => expect(totals).toHaveBeenCalledWith('abc', [3], null));

  await user.click(addOnButtons()[1]);
  await waitFor(() => expect(totals).toHaveBeenCalledWith('abc', [], null));

  const accept = screen.getByRole('button', { name: /^accept/i });
  await waitFor(() => expect(accept).toBeEnabled());
  await user.click(accept);
  await waitFor(() => expect(respond).toHaveBeenCalledWith('abc', 'accept', expect.objectContaining({
    selectedOptional: [], expectedTotalMinor: 100000,
  }), null));
  // No new message typed: the earlier one is kept, nothing is re-sent.
  expect(respond.mock.calls[0][2]).not.toHaveProperty('customerMessage');
});

it('shows the final choice read-only once the window has closed', async () => {
  get.mockResolvedValue({
    quote: {
      ...quote, status: 'accepted', canRespond: false, selectionLocked: true,
      respondedAt: '2026-09-01T10:00:00Z', responseLockedAt: '2026-09-01T10:15:00Z',
    },
  });
  renderPage();

  expect(await screen.findByText('Not booked')).toBeInTheDocument();
  expect(screen.getByText('Booked')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^(Book|Remove booking)$/ })).toBeNull();
  expect(screen.queryByLabelText('Your message to us (optional)')).toBeNull();
  expect(totals).not.toHaveBeenCalled();
});

it('leaves the unit price empty on a package line that is the sum of its items', async () => {
  get.mockResolvedValue({
    quote: {
      ...quote,
      lineItems: [
        { ...line(1, 'Wedding Basic', 0), lineTotalMinor: 340200 },
        line(2, 'Photography', 12000, { parentPosition: 1, quantity: 8, lineTotalMinor: 96000 }),
        line(3, 'Album', 39000),
      ],
    },
  });
  renderPage();

  const row = (await screen.findByText('Wedding Basic')).closest('tr') as HTMLElement;
  const cells = within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
  // [#, description, quantity, unit price, total]
  expect(cells[3]).toBe('');
  expect(cells[4]).toMatch(/3.402\.00/);
  // A plain line keeps its unit price.
  const album = screen.getByText('Album').closest('tr') as HTMLElement;
  expect(within(album).getAllByRole('cell')[3].textContent).toMatch(/390\.00/);
});

it('configures an included product, confirms server totals and sends the exact selection on acceptance', async () => {
  const product = { id: 'print', name: 'Print', active: true, description: '', attributes: [{ id: 'size', name: 'Size', required: true, multiple: false, addOn: false, dependsOn: [], options: [{ id: 'large', name: 'Large print', active: true, imageId: null }] }] };
  get.mockResolvedValue({ quote: { ...quote, lineItems: [line(1, 'Print', 10000, { configurationDefinition: { version: 'definition-1', product, baseUnitPriceMinor: 10000, surcharges: [] } })], totalAmountMinor: 10000 } });
  totals.mockImplementation(async (_token: string, selected: number[], _grant: unknown, configurations: { values: Record<string, string[]> }[]) => {
    if (!configurations?.[0]?.values.size?.length) throw new Error('Choose Size');
    return { selectedOptional: selected, totalAmountMinor: 10000, netAmountMinor: 10000, vatAmountMinor: 0, shippingAmountMinor: 0, lines: [] };
  });
  const user = userEvent.setup(); renderPage();
  const option = await screen.findByLabelText('Large print');
  await user.click(option);
  await waitFor(() => expect(screen.getByRole('button', { name: /Accept/ })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /Accept/ }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith('abc', 'accept', expect.objectContaining({ expectedTotalMinor: 10000, configurations: [{ position: 1, definitionVersion: 'definition-1', values: { size: ['large'] } }] }), null));
});
