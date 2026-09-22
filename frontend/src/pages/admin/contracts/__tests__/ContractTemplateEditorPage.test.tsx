/**
 * Contract template editor (#1445): saving sends the loaded lockVersion and
 * the clause list, a concurrent save shows the reload banner instead of
 * overwriting, and publishing lists every problem the server found.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../../i18n/locales/en.json')).default as Record<string, unknown>;
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

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }),
}));

const get = vi.fn();
const saveDraft = vi.fn();
const publish = vi.fn();
const check = vi.fn();
vi.mock('../../../../services/contractTemplates.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contractTemplates.service')>(
    '../../../../services/contractTemplates.service',
  );
  return {
    ...actual,
    contractTemplatesService: {
      get: (...args: unknown[]) => get(...args),
      saveDraft: (...args: unknown[]) => saveDraft(...args),
      publish: (...args: unknown[]) => publish(...args),
      check: (...args: unknown[]) => check(...args),
      placeholders: vi.fn(async () => ({
        placeholders: [
          { key: 'event_date', category: 'event', conditional: true, label: { en: 'Event date', de: 'Datum' }, sample: { en: '12.06.2027', de: '12.06.2027' } },
        ],
      })),
      previewUrl: vi.fn(),
      draftFromVersion: vi.fn(),
      duplicate: vi.fn(),
    },
  };
});
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return { ...actual, contractsService: { listBlocks: vi.fn(async () => ({ blocks: [] })) } };
});

import { ContractTemplateEditorPage } from '../ContractTemplateEditorPage';

const detail = (lockVersion = 3) => ({
  template: {
    id: 5, name: 'Hochzeit', description: null, useCase: null, isSystem: false, status: 'draft',
    currentVersion: null, lockVersion, isDefault: false, createdAt: '', updatedAt: '',
  },
  draft: {
    id: 11, version: 1, status: 'draft', title: 'Hochzeitsvertrag', introText: { de: 'Hallo' }, outroText: {},
    contentSha256: null, publishedAt: null,
    items: [{
      kind: 'block', blockId: 7, section: 'scope', heading: null, body: {}, snapshot: {},
      block: { slug: 'scope_service', name: 'Leistung', isActive: true, bodies: { de: 'Bibliothekstext' } },
    }],
  },
  published: null,
  versions: [],
});

const apiError = (code: string, error: string, details?: unknown) =>
  Object.assign(new Error(error), { response: { data: { code, error, details } } });
const clean = { ok: true, pageCount: 3, itemPages: [{ position: 1, firstPage: 1, lastPage: 1 }], findings: [] };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/clients/contracts/templates/5']}>
        <Routes>
          <Route path="/admin/clients/contracts/templates/:id" element={<ContractTemplateEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(detail());
  saveDraft.mockResolvedValue(detail(4));
  check.mockResolvedValue(clean);
  publish.mockResolvedValue({ ...detail(5), version: 1, contentSha256: 'a'.repeat(64) });
});

it('saves the clause list with the lockVersion it loaded', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Add free text' }));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));

  await waitFor(() => expect(saveDraft).toHaveBeenCalledWith(5, expect.objectContaining({
    lockVersion: 3,
    title: 'Hochzeitsvertrag',
    introText: { de: 'Hallo' },
    items: [
      { kind: 'block', blockId: 7, body: {} },
      { kind: 'text', section: 'closing', heading: null, body: {} },
    ],
  })));
});

it('shows the reload banner when someone else saved first', async () => {
  const user = userEvent.setup();
  saveDraft.mockRejectedValue(apiError('TEMPLATE_CONFLICT', 'Someone else changed this template.'));
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));

  expect(await screen.findByText(/Someone else saved this template while you were editing/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
});

it('publishing runs the check first and stops on an error, located and in words', async () => {
  const user = userEvent.setup();
  check.mockResolvedValue({
    ok: false, pageCount: 3, itemPages: [],
    findings: [
      { code: 'PLACEHOLDER_UNKNOWN', severity: 'error', itemPosition: 1, locale: 'en', key: 'custmer', message: 'x' },
      { code: 'LOCALE_INCOMPLETE', severity: 'warning', itemPosition: 1, locale: 'en', message: 'y' },
    ],
  });
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Publish' }));

  expect(await screen.findByText('Clause 1 · Leistung (EN): unknown placeholder {{custmer}}.')).toBeInTheDocument();
  expect(screen.getByText('Clause 1 · Leistung: no EN text.')).toBeInTheDocument();
  expect(screen.getByText('Fix these before publishing')).toBeInTheDocument();
  expect(check).toHaveBeenCalledWith(5);
  expect(publish).not.toHaveBeenCalled();
});

it('"Go to" opens the clause in the finding\'s language and focuses its text', async () => {
  const user = userEvent.setup();
  check.mockResolvedValue({
    ok: false, pageCount: 3, itemPages: [],
    findings: [{ code: 'PLACEHOLDER_UNKNOWN', severity: 'error', itemPosition: 1, locale: 'en', key: 'x', message: 'x' }],
  });
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Check' }));
  await user.click(await screen.findByRole('button', { name: 'Go to' }));

  const textarea = await screen.findByRole('textbox', { name: /Text in this template/ });
  expect(textarea).toHaveAttribute('id', expect.stringMatching(/-body-en$/));
  await waitFor(() => expect(textarea).toHaveFocus());
});

it('a clean check publishes; warnings alone do not block', async () => {
  const user = userEvent.setup();
  check.mockResolvedValue({
    ...clean, findings: [{ code: 'PAGE_COUNT_HIGH', severity: 'warning', message: 'long' }],
  });
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Publish' }));
  await waitFor(() => expect(publish).toHaveBeenCalledWith(5, 4));
});

it('shows the findings of a publish the server refused', async () => {
  const user = userEvent.setup();
  publish.mockRejectedValue(apiError('TEMPLATE_INVALID', 'invalid', {
    findings: [{ code: 'BLOCK_ARCHIVED', severity: 'error', itemPosition: 1, message: 'archived' }],
  }));
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Publish' }));
  expect(await screen.findByText('Clause 1 · Leistung: archived in the clause library.')).toBeInTheDocument();
});

it('"Show only if…" wraps the clause in every language and saves it', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Text' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Show only if…' }), 'event_date');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(saveDraft).toHaveBeenCalledWith(5, expect.objectContaining({
    items: [{ kind: 'block', blockId: 7, body: { de: '{{#if event_date}}Bibliothekstext{{/if}}' } }],
  })));

  // Back to "Always show": the clause returns to the library text.
  if (!screen.queryByRole('combobox', { name: 'Show only if…' })) await user.click(screen.getByRole('button', { name: 'Text' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Show only if…' }), '');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(saveDraft).toHaveBeenLastCalledWith(5, expect.objectContaining({
    items: [{ kind: 'block', blockId: 7, body: {} }],
  })));
});
