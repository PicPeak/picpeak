/** The brief of a customer without a project, on the customer page (issue 2678). */
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { field, projectBrief } from './fixtures';

const state = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: unknown) => (typeof fb === 'string' ? fb : _k),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => d, formatTime: (d: string) => d, formatWallClock: (d: string) => d, formatDateTime: (d: string) => d }),
}));
vi.mock('../../../services/briefs.service', () => ({ briefsService: { get: state.get, save: state.save, notify: vi.fn() } }));
vi.mock('../../../services/eventTypes.service', () => ({
  eventTypesService: { getActiveEventTypes: vi.fn(async () => [{ id: 1, name: 'Wedding', slug_prefix: 'wedding' }, { id: 2, name: 'Birthday', slug_prefix: 'birthday' }]) },
}));

import { CustomerBriefCard } from '../CustomerBriefCard';

const customerBrief = projectBrief({
  occasion: null,
  fields: [field({ id: 5, label: 'Contact on the day', type: 'short_text', source: 'global' })],
  sharedArrangements: '',
});
const weddingBrief = projectBrief({
  occasion: 'wedding',
  fields: [
    field({ id: 5, label: 'Contact on the day', type: 'short_text', source: 'global' }),
    field({ id: 6, label: 'Dress code', type: 'short_text', source: 'occasion' }),
  ],
  sharedArrangements: '',
});

function mount(canEdit = true) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><CustomerBriefCard customerId={12} canEdit={canEdit} /></MemoryRouter>
  </QueryClientProvider>);
}

beforeEach(() => {
  state.get.mockReset().mockResolvedValue(customerBrief);
  state.save.mockReset().mockImplementation(async (_owner, payload) => ({ ...customerBrief, occasion: payload.occasion ?? null }));
});

it('picks an occasion and saves it with the card\'s own button', async () => {
  mount();
  const occasion = await screen.findByLabelText('Occasion');
  expect(screen.queryByRole('button', { name: 'Save brief' })).toBeNull();
  await screen.findByRole('option', { name: 'Wedding' });
  fireEvent.change(occasion, { target: { value: 'wedding' } });
  expect(screen.getByText('The fields of the new occasion appear after saving.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Shared arrangements'), { target: { value: 'Meet at noon' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith({ kind: 'customers', id: 12 }, { sharedArrangements: 'Meet at noon', occasion: 'wedding' }));
});

it('discards the draft', async () => {
  mount();
  const input = await screen.findByLabelText('Contact on the day');
  fireEvent.change(input, { target: { value: 'Clara' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(input).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'Save brief' })).toBeNull();
});

it('offers no save or notify to a role that may only read customers', async () => {
  mount(false);
  expect(await screen.findByLabelText('Occasion')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Notify customer' })).toBeNull();
});

it('keeps the occasion until edits to its own fields are saved', async () => {
  state.get.mockResolvedValue(weddingBrief);
  mount();
  const occasion = await screen.findByLabelText('Occasion');
  await screen.findByRole('option', { name: 'Birthday' });
  // A field for every occasion does not hold it.
  fireEvent.change(screen.getByLabelText('Contact on the day'), { target: { value: 'Clara' } });
  expect(occasion).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Dress code'), { target: { value: 'Black tie' } });
  expect(occasion).toBeDisabled();
  expect(screen.getByText('Save the changes to this occasion\'s fields before picking another occasion.')).toBeInTheDocument();
});

it('locks the old occasion\'s fields once another occasion is picked', async () => {
  state.get.mockResolvedValue(weddingBrief);
  mount();
  const occasion = await screen.findByLabelText('Occasion');
  await screen.findByRole('option', { name: 'Birthday' });
  fireEvent.change(occasion, { target: { value: 'birthday' } });
  expect(screen.getByLabelText('Dress code')).toBeDisabled();
  expect(screen.getByLabelText('Contact on the day')).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith({ kind: 'customers', id: 12 }, { occasion: 'birthday' }));
});
