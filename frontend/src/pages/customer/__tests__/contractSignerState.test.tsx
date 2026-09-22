/**
 * Portal contracts list (#1446): no Sign button once the customer has signed
 * or before their turn — a hint says where they stand instead.
 */
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = lookup(k) ?? `MISSING:${k}`;
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        return vars ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? '')) : base;
      },
      i18n: { language: 'en' },
    }),
  };
});

const listContracts = vi.fn();
vi.mock('../../../services/customer.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/customer.service')>('../../../services/customer.service');
  return { ...actual, customerService: { ...actual.customerService, listContracts: () => listContracts() } };
});

import { CustomerContractsPage } from '../CustomerContractsPage';

const base = {
  language: 'en', issueDate: '2026-09-01', validUntil: null, title: null, sentAt: '2026-09-01', signedByCustomerAt: null,
  signedByAdminAt: null, signedCustomerName: null, signedAdminName: null, hasPdf: true, hasSignedPdf: false, status: 'sent',
};

test('says where the customer stands instead of offering Sign', async () => {
  listContracts.mockResolvedValue([
    { ...base, id: 1, contractNumber: 'C-1', canSign: false, signerState: 'signed', signerProgress: { signed: 1, total: 2 } },
    { ...base, id: 2, contractNumber: 'C-2', canSign: false, signerState: 'waiting', waitingFor: 'Ben Muster' },
    { ...base, id: 3, contractNumber: 'C-3', canSign: true, signerState: null },
  ]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><CustomerContractsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('You\'ve signed — waiting for the others.')).toBeInTheDocument();
  expect(screen.getByText('Partly signed (1 of 2)')).toBeInTheDocument();
  expect(screen.getByText('Your turn comes after Ben Muster.')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Sign' })).toHaveLength(1);
  expect(document.body.textContent).not.toContain('MISSING:');
});
