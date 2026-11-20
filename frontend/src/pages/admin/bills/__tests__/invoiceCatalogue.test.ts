/**
 * What the invoice editor's catalogue offers (service options PR): only what
 * an invoice can price on its own, in the invoice's currency.
 */
import { invoiceCatalogue } from '../BillEditorPage';
import type { LineItemPreset } from '../../../../services/quotes.service';
import type { QuotePackage } from '../../../../services/quoteCatalog.service';

const preset = (over: Partial<LineItemPreset>) => ({
  id: 1, name: 'x', description: '', unitPriceMinor: 1000, currency: 'CHF', quantityDefault: 1, displayOrder: 0,
  isActive: true, priceMode: 'fixed', pinnedRateMinor: null, productId: null, factorIds: [], ...over,
} as LineItemPreset);
const pkg = (over: Partial<QuotePackage>) => ({
  id: 1, name: 'p', currency: 'CHF', items: [{ presetId: 1, priceMode: 'fixed' }], ...over,
} as unknown as QuotePackage);

test('offers only services an invoice can price, in its currency', () => {
  const presets = [
    preset({ id: 1, name: 'CHF fixed' }),
    preset({ id: 2, name: 'EUR fixed', currency: 'EUR' }),
    preset({ id: 3, name: 'hourly, own rate', priceMode: 'hour', pinnedRateMinor: 9000 }),
    preset({ id: 4, name: 'hourly, rate chain', priceMode: 'hour' }),
    preset({ id: 5, name: 'factors', factorIds: [7] }),
    preset({ id: 6, name: 'product', productId: 'album-1' }),
    preset({ id: 7, name: 'chf lower case', currency: 'chf' }),
  ];
  expect(invoiceCatalogue(presets, [], 'CHF').presets.map((p) => p.id)).toEqual([1, 3, 7]);
  expect(invoiceCatalogue(presets, [], 'EUR').presets.map((p) => p.id)).toEqual([2]);
});

test('offers only packages in its currency made of such services', () => {
  const presets = [preset({ id: 1 }), preset({ id: 5, factorIds: [7] })];
  const packages = [
    pkg({ id: 10 }),
    pkg({ id: 11, currency: 'EUR' }),
    pkg({ id: 12, items: [{ presetId: 5, priceMode: 'fixed' }] as QuotePackage['items'] }),
  ];
  expect(invoiceCatalogue(presets, packages, 'CHF').packages.map((p) => p.id)).toEqual([10]);
});
