/**
 * The placeholder picker (#1445): searchable, grouped, keyboard-operable,
 * and it inserts at the caret of its text field.
 */
import React, { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
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
    placeholders: vi.fn(async () => ({
      placeholders: [
        { key: 'customer_name', category: 'customer', conditional: false, label: { en: 'Customer name', de: 'Name' }, sample: { en: 'Anna Muster', de: 'Anna Muster' } },
        { key: 'event_date', category: 'event', conditional: true, label: { en: 'Event date', de: 'Datum' }, sample: { en: '12.06.2027', de: '12.06.2027' } },
      ],
    })),
  },
}));

import { PlaceholderPicker } from '../PlaceholderPicker';

const Field: React.FC = () => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('Hello , see you');
  return (
    <>
      <textarea aria-label="Text" ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
      <PlaceholderPicker target={ref} onInsert={setValue} />
    </>
  );
};

function renderField() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Field /></QueryClientProvider>);
}

it('inserts the chosen placeholder at the caret', async () => {
  const user = userEvent.setup();
  renderField();
  const text = screen.getByRole('textbox', { name: 'Text' }) as HTMLTextAreaElement;
  text.focus();
  text.setSelectionRange(6, 6);
  await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
  await user.click(await screen.findByText('Customer name'));
  expect(text.value).toBe('Hello {{customer_name}}, see you');
  await waitFor(() => expect(text).toHaveFocus());
});

it('shows label, key and sample, grouped by category, and filters by search', async () => {
  const user = userEvent.setup();
  renderField();
  await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
  expect(await screen.findByText(/e\.g\. Anna Muster/)).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Customer' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Event' })).toBeInTheDocument();
  await user.type(screen.getByRole('combobox', { name: 'Search placeholders' }), 'date');
  expect(screen.queryByText('Customer name')).not.toBeInTheDocument();
  expect(screen.getByText('Event date')).toBeInTheDocument();
});

it('works from the keyboard: arrows, Enter inserts, Esc closes and returns focus to the text', async () => {
  const user = userEvent.setup();
  renderField();
  const text = screen.getByRole('textbox', { name: 'Text' }) as HTMLTextAreaElement;
  text.setSelectionRange(0, 0);
  await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
  const search = await screen.findByRole('combobox', { name: 'Search placeholders' });
  await waitFor(() => expect(search).toHaveFocus());
  await screen.findByText('Event date');
  await user.keyboard('{ArrowDown}{Enter}');
  expect(text.value).toBe('{{event_date}}Hello , see you');

  await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
  await screen.findByRole('combobox', { name: 'Search placeholders' });
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(text).toHaveFocus();
});
