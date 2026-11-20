/**
 * Service options (migration 371) in the invoice editor: a line added from a
 * catalogue service shows a checkbox per option; ticking one adds it as a
 * sub-line whose price adds to the line's own price, unticking removes it.
 */
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { LineItemsTable, generatedSubLines, toPayloadLineItem, type EditableLineItem, type LineItemPresetMinimal } from '../LineItemsTable';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  const fill = (s: string, vars?: Record<string, unknown>) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''));
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, vars?: Record<string, unknown>) => {
        const opts = (typeof fb === 'object' ? fb : vars) as Record<string, unknown> | undefined;
        return fill(lookup(k) ?? (typeof fb === 'string' ? fb : k), opts);
      },
      i18n: { language: 'en' },
    }),
  };
});

const gallery: LineItemPresetMinimal = { id: 9, name: 'Online Galerie', description: '', unitPriceMinor: 3000, quantityDefault: 1 };
const typeB: LineItemPresetMinimal = {
  id: 2, name: 'Typ B', description: '', unitPriceMinor: 18000, quantityDefault: 1, optionPresetIds: [9],
};

let latest: EditableLineItem[] = [];

function Harness({ initial }: { initial: EditableLineItem[] }) {
  const [items, setItems] = useState(initial);
  latest = items;
  return (
    <LineItemsTable currency="CHF" showDiscount={false} mode="invoice" presets={[typeB, gallery]}
      items={items} onChange={(next) => { latest = next; setItems(next); }} />
  );
}

const typeBLine: EditableLineItem = {
  position: 1, quantity: 1, description: '28.09.2024: 10. Next-Step B', unitPrice: 180,
  discountPercent: 0, parentPosition: null, cataloguePresetId: 2,
};

test('ticking the option adds a sub-line that adds to the line, unticking removes it', async () => {
  render(<Harness initial={[typeBLine]} />);
  const option = screen.getByRole('checkbox', { name: /Online Galerie/ });
  await userEvent.click(option);

  expect(latest).toHaveLength(2);
  expect(latest[1]).toMatchObject({
    parentPosition: 1, description: 'Online Galerie', unitPrice: 30, addsToParent: true, cataloguePresetId: 9,
  });
  // The line keeps its own 180 and shows 210; the parent stays editable.
  const parentRow = screen.getByDisplayValue('28.09.2024: 10. Next-Step B').closest('tr') as HTMLElement;
  expect(within(parentRow).getByText(/210\.00/)).toBeTruthy();
  expect((within(parentRow).getByDisplayValue('180.00') as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByText("included in the main line's price")).toBeTruthy();
  expect(toPayloadLineItem(latest[1])).toMatchObject({ addsToParent: true, unitPriceMinor: 3000 });

  await userEvent.click(screen.getByRole('checkbox', { name: /Online Galerie/ }));
  expect(latest).toHaveLength(1);
});

test('a line added from the catalogue on an invoice keeps its service link', async () => {
  render(<Harness initial={[]} />);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /Add from preset/ }), '2');
  expect(latest[0]).toMatchObject({ cataloguePresetId: 2, description: 'Typ B', unitPrice: 180 });
  expect(screen.getByRole('checkbox', { name: /Online Galerie/ })).toBeTruthy();
});

test('an option that no longer fits the document is not offered', () => {
  const euroGallery: LineItemPresetMinimal = { ...gallery, id: 10, name: 'EUR Galerie', currency: 'EUR' };
  const hourly: LineItemPresetMinimal = { ...gallery, id: 11, name: 'Stundenoption', priceMode: 'hour', currency: 'CHF' };
  const service: LineItemPresetMinimal = { ...typeB, optionPresetIds: [9, 10, 11] };
  render(<LineItemsTable currency="CHF" showDiscount={false} mode="invoice" presets={[service, { ...gallery, currency: 'CHF' }, euroGallery, hourly]}
    items={[typeBLine]} onChange={() => {}} />);
  expect(screen.getByRole('checkbox', { name: /Online Galerie/ })).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: /EUR Galerie/ })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: /Stundenoption/ })).toBeNull();
});

test('unticking an option whose line was edited by hand asks first', async () => {
  const edited: EditableLineItem = {
    position: 2, quantity: 1, description: 'Online Galerie', unitPrice: 25, discountPercent: 0,
    parentPosition: 1, cataloguePresetId: 9, addsToParent: true,
  };
  const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<Harness initial={[typeBLine, edited]} />);
  await userEvent.click(screen.getByRole('checkbox', { name: /Online Galerie/ }));
  expect(ask).toHaveBeenCalledTimes(1);
  expect(latest).toHaveLength(2);
  await userEvent.click(screen.getByRole('checkbox', { name: /Online Galerie/ }));
  expect(latest).toHaveLength(1);
  ask.mockRestore();
});

test('an hourly service with its own rate comes onto an invoice at that rate', async () => {
  const hourly: LineItemPresetMinimal = {
    id: 20, name: 'Retusche', description: '', unitPriceMinor: 0, quantityDefault: 2, priceMode: 'hour', pinnedRateMinor: 9000,
  };
  let rows: EditableLineItem[] = [];
  render(<LineItemsTable currency="CHF" showDiscount={false} mode="invoice" presets={[hourly]}
    items={[]} onChange={(next) => { rows = next; }} />);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /Add from preset/ }), '20');
  expect(rows[0]).toMatchObject({ unitPrice: 90, unit: 'hour', quantity: 2, priceMode: null });
});

test('options with a product or pricing factors are not offered; a booked one still shows ticked', async () => {
  const product: LineItemPresetMinimal = { ...gallery, id: 30, name: 'Album', productId: 'album-1' };
  const factored: LineItemPresetMinimal = { ...gallery, id: 31, name: 'Druck', factorIds: [4] };
  const service: LineItemPresetMinimal = { ...typeB, optionPresetIds: [30, 31] };
  const booked: EditableLineItem = {
    position: 2, quantity: 1, description: 'Altes Extra', unitPrice: 20, discountPercent: 0,
    parentPosition: 1, cataloguePresetId: 99, addsToParent: true,
  };
  latest = [];
  render(<LineItemsTable currency="CHF" showDiscount={false} mode="invoice" presets={[service, product, factored]}
    items={[typeBLine, booked]} onChange={(next) => { latest = next; }} />);
  expect(screen.queryByRole('checkbox', { name: /Album/ })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: /Druck/ })).toBeNull();
  const old = screen.getByRole('checkbox', { name: /Altes Extra/ }) as HTMLInputElement;
  expect(old.checked).toBe(true);
  // No catalogue entry to compare with: it always asks, and Cancel keeps it.
  const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  await userEvent.click(old);
  expect(latest).toHaveLength(0);
  await userEvent.click(old);
  expect(ask).toHaveBeenCalledTimes(2);
  expect(latest).toHaveLength(1);
  ask.mockRestore();
});

test('an option booked twice over shows its quantity in the label', () => {
  const twice: LineItemPresetMinimal = { ...gallery, quantityDefault: 2 };
  render(<LineItemsTable currency="CHF" showDiscount={false} mode="invoice" presets={[typeB, twice]}
    items={[typeBLine]} onChange={() => {}} />);
  expect(screen.getByRole('checkbox', { name: /Online Galerie \(2 × CHF.30\.00\)/ })).toBeTruthy();
});

test('re-pricing a factor service never takes its ticked options', () => {
  const items: EditableLineItem[] = [
    { position: 1, quantity: 1, description: 'Shoot', unitPrice: 0, discountPercent: 0, parentPosition: null,
      pricingFactors: { presetId: 2, values: {} } as unknown as EditableLineItem['pricingFactors'] },
    { position: 2, quantity: 1, description: 'Base', unitPrice: 100, discountPercent: 0, parentPosition: 1 },
    { position: 3, quantity: 1, description: 'Online Galerie', unitPrice: 30, discountPercent: 0, parentPosition: 1, addsToParent: true },
  ];
  expect([...generatedSubLines(items, 1)]).toEqual([2]);
});

test('the option row shows its amount in brackets like any sub-line, and the preview rounds in Rappen like the server', () => {
  const items: EditableLineItem[] = [
    { ...typeBLine, unitPrice: 0.35, quantity: 1.5 },
    { position: 2, quantity: 1.5, description: 'Online Galerie', unitPrice: 0.35, discountPercent: 0, parentPosition: 1, cataloguePresetId: 9, addsToParent: true },
  ];
  render(<LineItemsTable currency="CHF" showDiscount={false} mode="invoice" presets={[typeB, gallery]} items={items} onChange={() => {}} />);
  const optionRow = screen.getByDisplayValue('Online Galerie').closest('tr') as HTMLElement;
  expect(optionRow.textContent).toMatch(/\(CHF.0\.53\)/);
  // 1.5 × 35 Rappen = 52.5 → 53, twice: 1.06 (a float product of francs gives 1.04).
  const parentRow = screen.getByDisplayValue('28.09.2024: 10. Next-Step B').closest('tr') as HTMLElement;
  expect(parentRow.textContent).toMatch(/1\.06/);
});
