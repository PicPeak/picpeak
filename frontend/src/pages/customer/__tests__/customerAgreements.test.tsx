/** Portal → Agreements (issue 2678): the briefs the studio sent, read-only. */
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { formatMoneyMinor } from '../../../utils/money';

const { listAgreements } = vi.hoisted(() => ({ listAgreements: vi.fn() }));
vi.mock('../../../services/customer.service', () => ({ customerService: { listAgreements } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: unknown, opts?: Record<string, unknown>) =>
      (typeof fb === 'string' ? fb.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts?.[key] ?? '')) : _k),
    i18n: { language: 'de-CH' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => `day:${d}`, formatTime: (d: string) => `time:${d}`, formatWallClock: (d: string) => d, formatDateTime: (d: string) => `at:${d}` }),
}));

import { CustomerAgreementsPage } from '../CustomerAgreementsPage';

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><CustomerAgreementsPage /></MemoryRouter>
  </QueryClientProvider>);
}

beforeEach(() => { listAgreements.mockReset(); });

it('shows the sent fields in the reader\'s language, the arrangements, price and deposit', async () => {
  listAgreements.mockResolvedValue([{
    id: 1, title: 'Anna & Ben', updatedAt: '2027-01-02T10:00:00Z',
    fields: [
      { id: 1, label: "Bride's name", labels: { de: 'Name der Braut' }, type: 'short_text', value: 'Anna' },
      { id: 2, label: 'Wedding date', labels: {}, type: 'project_date', value: '2027-06-12' },
      { id: 3, label: 'Bride pickup', labels: {}, type: 'place_time', value: { place: 'Hotel Rose', address: 'Main St 1', time: '09:30' } },
      { id: 4, label: 'Plus-one', labels: {}, type: 'yes_no', value: false },
    ],
    sharedArrangements: 'Coffee at 9.',
    price: { quoteNumber: 'Q-1', totalMinor: 450000, currency: 'CHF' },
    deposit: { invoiceNumber: 'I-1', totalMinor: 135000, currency: 'CHF', dueDate: '2027-01-31', paid: false },
  }]);
  mount();
  expect(await screen.findByRole('heading', { name: 'Anna & Ben' })).toBeInTheDocument();
  expect(screen.getByText('Updated on at:2027-01-02T10:00:00Z')).toBeInTheDocument();
  expect(screen.getByText('Name der Braut')).toBeInTheDocument();
  expect(screen.getByText('day:2027-06-12')).toBeInTheDocument();
  expect(screen.getByText('time:09:30, Hotel Rose, Main St 1')).toBeInTheDocument();
  expect(screen.getByText('No')).toBeInTheDocument();
  expect(screen.getByText('Coffee at 9.')).toBeInTheDocument();
  expect(screen.getByText((_, el) => el?.tagName === 'DD' && el.textContent === `${formatMoneyMinor(450000, 'CHF')} · Quote Q-1`)).toBeInTheDocument();
  expect(screen.getByText('Due day:2027-01-31')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('marks a paid deposit and leaves out what the server did not send', async () => {
  listAgreements.mockResolvedValue([{
    id: 2, title: null, updatedAt: '2027-01-02T10:00:00Z', fields: [], sharedArrangements: '',
    price: null, deposit: { invoiceNumber: 'I-2', totalMinor: 1000, currency: 'EUR', dueDate: null, paid: true },
  }]);
  mount();
  expect(await screen.findByRole('heading', { name: 'Your booking' })).toBeInTheDocument();
  expect(screen.getByText('Paid')).toBeInTheDocument();
  expect(screen.queryByText('Price')).toBeNull();
  expect(screen.queryByText('Arrangements')).toBeNull();
});

it('says so when there is nothing for this account', async () => {
  listAgreements.mockRejectedValue({ response: { status: 403 } });
  mount();
  expect(await screen.findByText('There are no agreements for your account yet.')).toBeInTheDocument();
});
