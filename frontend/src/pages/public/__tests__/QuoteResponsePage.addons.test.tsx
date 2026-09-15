/**
 * Public quote page — optional add-ons (#1451 phase 2).
 *
 * The customer ticks add-ons, the page shows the server's totals for that
 * choice, and accepting sends the choice with the total that was shown.
 * Once accepted the choice is shown read-only.
 */
import { render, screen, waitFor } from '@testing-library/react';
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
  respondedAt: null, responseLockedAt: null, canRespond: true, selectionLocked: false,
  lineItems: [
    line(1, 'Wedding day', 100000),
    line(2, 'Album', 30000, { isOptional: true, selected: false }),
    line(3, 'Drone', 20000, { isOptional: true, selected: true }),
  ],
  tos: { required: false, text: '', url: '', acceptedAt: null },
  recipient: null,
  issuer: null,
};

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

it('recalculates as add-ons are ticked and accepts with the total shown', async () => {
  const user = userEvent.setup();
  renderPage();

  const album = await screen.findByRole('checkbox', { name: 'Album' });
  expect(album).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Drone' })).toBeChecked();
  await waitFor(() => expect(totals).toHaveBeenCalledWith('abc', [3]));

  await user.click(album);
  await waitFor(() => expect(totals).toHaveBeenCalledWith('abc', [2, 3]));

  const accept = screen.getByRole('button', { name: /^accept/i });
  await waitFor(() => expect(accept).toBeEnabled());
  await user.click(accept);
  await waitFor(() => expect(respond).toHaveBeenCalledWith('abc', 'accept', expect.objectContaining({
    selectedOptional: [2, 3], expectedTotalMinor: 150000,
  })));
});

it('shows the fixed choice read-only once accepted', async () => {
  get.mockResolvedValue({
    quote: {
      ...quote, status: 'accepted', canRespond: false, selectionLocked: true,
      respondedAt: '2026-09-01T10:00:00Z',
    },
  });
  renderPage();

  expect(await screen.findByText('Not chosen')).toBeInTheDocument();
  expect(screen.getByText('Included')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(totals).not.toHaveBeenCalled();
});
