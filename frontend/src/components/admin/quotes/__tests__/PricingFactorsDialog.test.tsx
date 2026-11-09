/**
 * Pricing factors in the quote editor (#2440): adding a catalogue item that
 * has factors asks for the values first; "Apply" inserts the item as a
 * parent line holding the snapshot, with one priced sub-line per result
 * line. Editing the factors again replaces only that item's sub-lines.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { LineItemsTable, type EditableLineItem } from '../../LineItemsTable';
import type { FactorPriceResult, PricingFactor } from '../../../../services/quoteCatalog.service';

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
      t: (k: string, fb?: unknown) => lookup(k) ?? (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

// Product choices (#1924) load their own catalogue; not under test here.
vi.mock('../../../../features/album-products/QuoteLineConfiguration', () => ({ QuoteLineConfiguration: () => null }));

const drone: PricingFactor = {
  id: 5, name: 'Drone', description: null, inputType: 'toggle', effect: 'fixed', unitLabel: null, currency: 'CHF',
  amountMinor: 25000, percent: null, includedUnits: null, stepSize: null, minValue: null, maxValue: null,
  defaultValue: null, clientVisible: true, displayOrder: 0, isActive: true, options: [],
};

const preset = {
  id: 9, name: 'Music video shoot', description: '', unitPriceMinor: 100000, quantityDefault: 1, factorIds: [5],
};

const result = (droneOn: boolean): FactorPriceResult => {
  const lines: FactorPriceResult['lines'] = [
    { kind: 'base', factorId: null, description: 'Base price', quantity: 1, unit: null, unitPriceMinor: 100000, totalMinor: 100000, priceMode: null, rateSource: null },
    ...(droneOn ? [{ kind: 'factor' as const, factorId: 5, description: 'Drone', quantity: 1, unit: null, unitPriceMinor: 25000, totalMinor: 25000, priceMode: null, rateSource: null }] : []),
  ];
  return {
    currency: 'CHF',
    baseMinor: 100000,
    totalMinor: droneOn ? 125000 : 100000,
    unmatched: [],
    lines,
    snapshot: {
      version: 1, presetId: 9, presetName: 'Music video shoot', currency: 'CHF', quantity: 1,
      values: { 5: droneOn }, factors: [{ id: 5, name: 'Drone', inputType: 'toggle' }], unmatched: [],
      lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
    },
  };
};

test('adding an item with factors asks for them, then inserts parent + priced sub-lines', async () => {
  const onChange = vi.fn();
  const price = vi.fn(async (_presetId: number, values: Record<string, unknown>) => result(values[5] === true));
  render(
    <LineItemsTable items={[]} currency="CHF" mode="quote" presets={[preset]} factors={[drone]}
      priceWithFactors={price} onChange={onChange} />,
  );

  await userEvent.selectOptions(screen.getByRole('combobox', { name: /Add from preset/ }), '9');
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Drone' }));
  await waitFor(() => expect(screen.getByText('CHF 1,250.00')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Apply to quote' }));

  const lines: EditableLineItem[] = onChange.mock.calls.at(-1)![0];
  expect(lines.map((l) => [l.position, l.parentPosition ?? null, l.description, l.unitPrice])).toEqual([
    [1, null, 'Music video shoot', 0],
    [2, 1, 'Base price', 1000],
    [3, 1, 'Drone', 250],
  ]);
  expect(lines[0].cataloguePresetId).toBe(9);
  expect(lines[0].pricingFactors?.values).toEqual({ 5: true });
  expect(price).toHaveBeenLastCalledWith(9, { 5: true });
});

test('editing the factors again replaces only the lines it made, and says which stay', async () => {
  const onChange = vi.fn();
  const price = vi.fn(async (_presetId: number, values: Record<string, unknown>) => result(values[5] === true));
  const items: EditableLineItem[] = [
    { position: 1, parentPosition: null, description: 'Music video shoot', quantity: 1, unitPrice: 0, discountPercent: 0, cataloguePresetId: 9, pricingFactors: result(true).snapshot },
    { position: 2, parentPosition: 1, description: 'Base price', quantity: 1, unitPrice: 1000, discountPercent: 0 },
    { position: 3, parentPosition: 1, description: 'Drone', quantity: 1, unitPrice: 250, discountPercent: 0 },
    // Added by hand after the first pricing: stays.
    { position: 5, parentPosition: 1, description: 'Extra edit round', quantity: 1, unitPrice: 120, discountPercent: 0 },
    { position: 4, parentPosition: null, description: 'Prints', quantity: 1, unitPrice: 80, discountPercent: 0 },
  ];
  render(
    <LineItemsTable items={items} currency="CHF" mode="quote" presets={[preset]} factors={[drone]}
      priceWithFactors={price} onChange={onChange} />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'Pricing factors' }));
  expect(screen.getByRole('checkbox', { name: 'Drone' })).toBeChecked();
  expect(screen.getByRole('note')).toHaveTextContent(/added or changed by hand/);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Drone' }));
  await waitFor(() => expect(price).toHaveBeenLastCalledWith(9, { 5: false }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to quote' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Apply to quote' }));

  const lines: EditableLineItem[] = onChange.mock.calls.at(-1)![0];
  expect(lines.map((l) => [l.parentPosition ?? null, l.description])).toEqual([
    [null, 'Music video shoot'],
    [1, 'Base price'],
    [1, 'Extra edit round'],
    [null, 'Prints'],
  ]);
  expect(lines[0].pricingFactors?.values).toEqual({ 5: false });
});
