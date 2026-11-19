/**
 * The contract page's price table has no unit price column, so an option
 * line (migration 371) keeps its amount there, marked as part of the main
 * line's price; a regular sub-line is unchanged.
 */
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { ContractBody } from '../ContractBody';
import type { ContractBodyContent } from '../../../services/contracts.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (_k: string, fb?: unknown) => (typeof fb === 'string' ? fb : _k), i18n: { language: 'en' } }),
  };
});

const content = {
  title: 'Contract', contractNumber: 'V-1', language: 'en', recipient: null, introText: null, outroText: null, sections: [],
  commercial: {
    sourceQuoteNumber: null,
    currency: 'CHF',
    lineItems: [
      { position: 1, parentPosition: null, kind: 'item', description: 'Next-Step B', details: null, unit: null, quantity: 1, unitPriceMinor: 18000, discountPercent: 0, lineTotalMinor: 21000 },
      { position: 2, parentPosition: 1, kind: 'item', description: 'Online Galerie', details: null, unit: null, quantity: 1, unitPriceMinor: 3000, discountPercent: 0, lineTotalMinor: 3000, addsToParent: true },
    ],
    totals: { netAmountMinor: 21000, vatAmountMinor: 0, totalAmountMinor: 21000, vatRate: 0, shippingAmountMinor: 0 },
  },
} as unknown as ContractBodyContent;

test('an option keeps its amount on the contract page, marked as part of the main line', () => {
  render(<ContractBody contract={content} />);
  const row = screen.getByText('Online Galerie').closest('tr') as HTMLElement;
  expect(row.textContent).toMatch(/30\.00/);
  expect(row.textContent).toMatch(/included in the main line's price/);
  const main = screen.getByText('Next-Step B').closest('tr') as HTMLElement;
  expect(main.textContent).not.toMatch(/included in the main line/);
});
