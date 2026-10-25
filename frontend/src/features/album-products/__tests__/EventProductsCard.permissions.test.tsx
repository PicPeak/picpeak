import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { EventProductsCard } from '../EventProductsCard';
const state = vi.hoisted(() => ({ bills: true, permissions: new Set<string>(), get: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }), initReactI18next: { type: '3rdParty', init: () => {} } }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: (key: string) => key === 'albumProducts' || (key === 'bills' && state.bills) }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission: (key: string) => state.permissions.has(key) }) }));
vi.mock('../../../config/api', () => ({ api: { get: (...args: unknown[]) => state.get(...args) } }));
vi.mock('../model', () => ({ errorMessage: (error: Error) => error.message, albumProducts: { event: vi.fn(async () => ({
  catalogue: { products: [{ id: 'print', name: 'Print', active: true }] },
  offers: [{ id: 'offer', productId: 'print', enabled: true, revision: 1, status: 'submitted', selection: null }],
})) } }));
function mount(ownsEvent: boolean) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><EventProductsCard eventId={7} ownsEvent={ownsEvent} /></MemoryRouter>
  </QueryClientProvider>);
}
beforeEach(() => {
  state.bills = true;
  state.permissions = new Set(['products.view', 'products.configure', 'bills.manage']);
  state.get.mockReset().mockResolvedValue({ data: { items: [], presets: [], customers: [] } });
});
it('lets an assigned administrator manage the offer without owner or billing actions', async () => {
  mount(false);
  await screen.findByText('Print');
  expect(screen.getByRole('button', { name: 'Hide offer' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Lock choice/ })).not.toBeInTheDocument();
  expect(state.get).not.toHaveBeenCalled();
});
it('keeps billing actions hidden from an owner without native billing permission', async () => {
  state.permissions.delete('bills.manage');
  mount(true);
  await screen.findByText('Print');
  expect(screen.queryByRole('button', { name: /Lock choice/ })).not.toBeInTheDocument();
  expect(state.get).not.toHaveBeenCalled();
});
it('allows the owner to confirm a non-billable choice with billing disabled', async () => {
  state.bills = false;
  state.permissions.delete('bills.manage');
  mount(true);
  expect(await screen.findByRole('button', { name: 'Lock choice', exact: true })).toBeInTheDocument();
  expect(state.get).not.toHaveBeenCalled();
});
it('loads financial controls for an owner with billing permission', async () => {
  mount(true);
  expect(await screen.findByRole('button', { name: 'Lock choice and add to billing' })).toBeInTheDocument();
  await waitFor(() => expect(state.get).toHaveBeenCalledWith('/admin/album-products/events/7/billing'));
});
