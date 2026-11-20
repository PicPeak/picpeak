/**
 * Service options in the catalogue (migration 371): an edit that leaves the
 * ticked options as they were does not send them, so it never writes over a
 * list another admin changed since the form loaded; changing a tick does.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

const { preset, update } = vi.hoisted(() => {
  const make = (over: Record<string, unknown>) => ({
    id: 1, name: 'Typ B', description: '', unitPriceMinor: 18000, currency: 'CHF', quantityDefault: 1, displayOrder: 0,
    isActive: true, unit: null, detailsText: null, category: null, vatCode: null, priceMode: 'fixed', pinnedRateMinor: null,
    productId: null, productSurcharges: [], factorIds: [], optionPresetIds: [], ...over,
  });
  return { preset: make, update: vi.fn() };
});
vi.mock('../../../../../services/quotes.service', () => ({
  quotesService: {
    listLineItemPresets: vi.fn().mockResolvedValue({
      presets: [
        preset({ id: 1, name: 'Typ B', optionPresetIds: [9] }),
        preset({ id: 9, name: 'Online Galerie', unitPriceMinor: 3000 }),
        preset({ id: 10, name: 'Album', unitPriceMinor: 9000 }),
      ],
    }),
    updateLineItemPreset: (...args: unknown[]) => update(...args),
    createLineItemPreset: vi.fn(),
    archiveLineItemPreset: vi.fn(),
  },
}));
vi.mock('../../../../../services/quoteCatalog.service', async () => {
  const actual = await vi.importActual<object>('../../../../../services/quoteCatalog.service');
  return { ...actual, quoteCatalogService: { listFactors: vi.fn().mockResolvedValue([]) } };
});
vi.mock('../../../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: () => false }));
vi.mock('../../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../../../features/album-products/CrmProductFields', () => ({ CrmProductFields: () => null }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { QuoteCatalogPage } from '../QuoteCatalogPage';

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><QuoteCatalogPage /></MemoryRouter>
  </QueryClientProvider>,
);

const openTypeB = async () => {
  const row = (await screen.findByText('Typ B')).closest('tr') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: /edit/i }));
};

beforeEach(() => { update.mockReset(); update.mockResolvedValue({ preset: preset({}) }); });

test('an edit that leaves the options alone does not send them', async () => {
  renderPage();
  await openTypeB();
  const name = screen.getByDisplayValue('Typ B');
  await userEvent.clear(name);
  await userEvent.type(name, 'Typ B neu');
  await userEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][1]).not.toHaveProperty('optionPresetIds');
});

test('ticking another option sends the new list', async () => {
  renderPage();
  await openTypeB();
  await userEvent.click(screen.getByRole('checkbox', { name: /Album/ }));
  await userEvent.click(screen.getByRole('button', { name: /save/i }));
  // With the list it loaded, for the server's check against a concurrent edit.
  expect(update.mock.calls[0][1]).toMatchObject({ optionPresetIds: [9, 10], expectedOptionPresetIds: [9] });
});

test('a save refused because the options changed keeps the other fields and takes the current list', async () => {
  const { quotesService } = await import('../../../../../services/quotes.service');
  renderPage();
  await openTypeB();
  const name = screen.getByDisplayValue('Typ B');
  await userEvent.clear(name);
  await userEvent.type(name, 'Typ B neu');
  await userEvent.click(screen.getByRole('checkbox', { name: /Album/ }));
  update.mockRejectedValueOnce({ response: { data: { code: 'PRESET_OPTIONS_CHANGED', error: 'The options changed' } } });
  vi.mocked(quotesService.listLineItemPresets).mockResolvedValueOnce({
    presets: [preset({ id: 1, name: 'Typ B', optionPresetIds: [9, 10] }), preset({ id: 9, name: 'Online Galerie' }), preset({ id: 10, name: 'Album' })],
  } as never);
  await userEvent.click(screen.getByRole('button', { name: /save/i }));
  // Still open, the typed name kept, the ticks now the stored list.
  expect(await screen.findByDisplayValue('Typ B neu')).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: /Album/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox', { name: /Online Galerie/ }) as HTMLInputElement).checked).toBe(true);
});
