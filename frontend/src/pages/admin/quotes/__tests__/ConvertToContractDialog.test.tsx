/**
 * Converting a quote to a contract (#1445): the dialog preselects the
 * contract template the quote's template names, and converts with the one
 * chosen.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({
    t: (_k: string, fb?: unknown, opts?: Record<string, unknown>) => {
      const base = typeof fb === 'string' ? fb : _k;
      return opts ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts[key] ?? '')) : base;
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../../services/contractTemplates.service', () => ({
  contractTemplatesService: {
    list: vi.fn(async () => ({
      templates: [
        { id: 1, name: 'Standard contract', status: 'published', currentVersionId: 11, isDefault: true },
        { id: 2, name: 'Wedding', status: 'published', currentVersionId: 21, isDefault: false },
        { id: 3, name: 'Old', status: 'archived', currentVersionId: 31, isDefault: false },
      ],
    })),
  },
}));
vi.mock('../../../../services/quoteCatalog.service', () => ({
  quoteCatalogService: { getTemplate: vi.fn(async () => ({ template: { id: 8, defaultContractTemplateId: 2 }, versions: [] })) },
}));

import { ConvertToContractDialog } from '../ConvertToContractDialog';

function renderDialog(sourceTemplateId: number | null) {
  const onConvert = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConvertToContractDialog sourceTemplateId={sourceTemplateId} onClose={vi.fn()} onConvert={onConvert} converting={false} />
    </QueryClientProvider>,
  );
  return onConvert;
}

it('preselects the contract template of the quote\'s template, and converts with the one chosen', async () => {
  const user = userEvent.setup();
  const onConvert = renderDialog(8);
  const select = await screen.findByRole('combobox', { name: 'Contract template' });
  await waitFor(() => expect(select).toHaveValue('2'));
  expect(screen.getByText("Preselected by the quote's template: Wedding")).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Old' })).not.toBeInTheDocument();
  await user.selectOptions(select, '1');
  await user.click(screen.getByRole('button', { name: 'Draft the contract' }));
  expect(onConvert).toHaveBeenCalledWith(1);
});

it('without a quote template it preselects the default contract template', async () => {
  const user = userEvent.setup();
  const onConvert = renderDialog(null);
  const select = await screen.findByRole('combobox', { name: 'Contract template' });
  await waitFor(() => expect(select).toHaveValue('1'));
  await user.click(screen.getByRole('button', { name: 'Draft the contract' }));
  expect(onConvert).toHaveBeenCalledWith(1);
});
