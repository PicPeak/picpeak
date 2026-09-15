/**
 * Attachment list editor (#1445): adding from the library (active entries
 * not already included), changing delivery, reordering and removing.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = lookup(k) ?? (typeof fb === 'string' ? fb : k);
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        if (!vars) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

const list = vi.fn();
vi.mock('../../../services/documentAttachments.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/documentAttachments.service')>(
    '../../../services/documentAttachments.service',
  );
  return { ...actual, documentAttachmentsService: { list: (...args: unknown[]) => list(...args) } };
});

import { AttachmentListEditor, type AttachmentRow } from '../AttachmentListEditor';

const library = (id: number, name: string, isActive = true) => ({
  id, name, description: null, originalName: null, sha256: 'a'.repeat(64), bytes: 2048, pages: 2, isActive, createdAt: '2026-09-01T10:00:00Z',
});
const row = (attachmentId: number, name: string): AttachmentRow => ({
  attachmentId, name, delivery: 'merged', pages: 2, bytes: 2048, isActive: true,
});

function renderEditor(value: AttachmentRow[], onChange = vi.fn(), readOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AttachmentListEditor idPrefix="t" value={value} onChange={onChange} readOnly={readOnly} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({ attachments: [library(1, 'AGB'), library(2, 'Datenschutz'), library(3, 'Alt', false)] });
});

test('offers active library entries that are not included yet', async () => {
  const onChange = renderEditor([row(1, 'AGB')]);
  const picker = screen.getByLabelText('Attachment from the library');
  await waitFor(() => expect(screen.getByRole('option', { name: 'Datenschutz' })).toBeInTheDocument());
  expect(screen.queryByRole('option', { name: 'Alt' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'AGB' })).not.toBeInTheDocument();

  await userEvent.selectOptions(picker, '2');
  await userEvent.click(screen.getByRole('button', { name: /Add attachment/ }));
  expect(onChange).toHaveBeenCalledWith([
    row(1, 'AGB'),
    expect.objectContaining({ attachmentId: 2, name: 'Datenschutz', delivery: 'merged' }),
  ]);
});

test('changes delivery, reorders and removes', async () => {
  const onChange = renderEditor([row(1, 'AGB'), row(2, 'Datenschutz')]);
  await userEvent.selectOptions(screen.getByLabelText('Delivery', { selector: '#t-2-delivery' }), 'separate');
  expect(onChange).toHaveBeenLastCalledWith([row(1, 'AGB'), { ...row(2, 'Datenschutz'), delivery: 'separate' }]);

  await userEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]);
  expect(onChange).toHaveBeenLastCalledWith([row(2, 'Datenschutz'), row(1, 'AGB')]);

  await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
  expect(onChange).toHaveBeenLastCalledWith([row(2, 'Datenschutz')]);
});

test('read-only shows the list without controls and skips the library', () => {
  renderEditor([row(1, 'AGB')], vi.fn(), true);
  expect(screen.getByText('AGB')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Attachment from the library')).not.toBeInTheDocument();
  expect(list).not.toHaveBeenCalled();
});
