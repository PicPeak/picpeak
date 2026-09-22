/**
 * Contract template editor (#1445): saving sends the loaded lockVersion and
 * the clause list, a concurrent save shows the reload banner instead of
 * overwriting, and publishing lists every problem the server found.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
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
const version = vi.fn();
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
      version: (...args: unknown[]) => version(...args),
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

it('a conflict keeps the local text, pauses autosave, and "Keep mine" saves it over the new version', async () => {
  const user = userEvent.setup();
  saveDraft.mockRejectedValueOnce(apiError('TEMPLATE_CONFLICT', 'Someone else changed this template.'));
  renderPage();
  await screen.findByText('Leistung');
  const title = screen.getByLabelText('Contract title');
  await user.clear(title);
  await user.type(title, 'Mein Titel');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));

  expect(await screen.findByText('Changed by someone else.')).toBeInTheDocument();
  expect(screen.getByLabelText('Contract title')).toHaveValue('Mein Titel');
  expect(screen.getByTestId('autosave-status')).toHaveTextContent('Not saved — changed by someone else');

  // Their version is at lock 7 now; mine goes on top of it.
  get.mockResolvedValue(detail(7));
  saveDraft.mockResolvedValue(detail(8));
  await user.click(screen.getByRole('button', { name: 'Keep mine' }));
  await waitFor(() => expect(saveDraft).toHaveBeenLastCalledWith(5, expect.objectContaining({ lockVersion: 7, title: 'Mein Titel' })));
  expect(screen.queryByText('Changed by someone else.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Contract title')).toHaveValue('Mein Titel');
});

it('"Take theirs" loads the other version, and Undo brings mine back', async () => {
  const user = userEvent.setup();
  saveDraft.mockRejectedValueOnce(apiError('TEMPLATE_CONFLICT', 'conflict'));
  renderPage();
  await screen.findByText('Leistung');
  const title = screen.getByLabelText('Contract title');
  await user.clear(title);
  await user.type(title, 'Mein Titel');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Changed by someone else.');

  const theirs = detail(9);
  get.mockResolvedValue({ ...theirs, draft: { ...theirs.draft, title: 'Ihr Titel' } });
  await user.click(screen.getByRole('button', { name: 'Take theirs' }));
  await waitFor(() => expect(screen.getByLabelText('Contract title')).toHaveValue('Ihr Titel'));
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByLabelText('Contract title')).toHaveValue('Mein Titel');
});

it('"Compare" shows their version against mine', async () => {
  const user = userEvent.setup();
  saveDraft.mockRejectedValueOnce(apiError('TEMPLATE_CONFLICT', 'conflict'));
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Add free text' }));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Changed by someone else.');
  await user.click(screen.getByRole('button', { name: 'Compare' }));
  const dialog = await screen.findByRole('dialog', { name: 'Their version and yours' });
  expect(dialog).toHaveTextContent('Added');
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

  // The request moves the focus once: typing elsewhere keeps it there.
  const name = screen.getByLabelText('Name');
  await user.click(name);
  await user.type(name, ' 2027');
  expect(name).toHaveFocus();
  expect(name).toHaveValue('Hochzeit 2027');
});

it('an edit made while the check runs marks its result as stale', async () => {
  const user = userEvent.setup();
  let answer: (value: typeof clean) => void = () => {};
  check.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(check).toHaveBeenCalled());
  await user.type(screen.getByDisplayValue('Hallo'), '!');
  await act(async () => { answer(clean); });
  expect(await screen.findByText('Changed since the check — check again')).toBeInTheDocument();
});

it('a clean check publishes; warnings alone do not block', async () => {
  const user = userEvent.setup();
  check.mockResolvedValue({
    ...clean, findings: [{ code: 'PAGE_COUNT_HIGH', severity: 'warning', message: 'long' }],
  });
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Publish' }));
  // Nothing changed since loading: no save, the loaded lock goes to publish.
  await waitFor(() => expect(publish).toHaveBeenCalledWith(5, 3));
  expect(saveDraft).not.toHaveBeenCalled();
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

it('"Show only if…" also wraps a language the clause inherits from the library', async () => {
  const user = userEvent.setup();
  const own = detail();
  own.draft.items = [{
    ...own.draft.items[0],
    body: { de: 'Eigener Text' } as Record<string, string>,
    block: { ...own.draft.items[0].block, bodies: { de: 'Bibliothekstext', en: 'Library text' } },
  }];
  get.mockResolvedValue(own);
  renderPage();
  await screen.findByText('Leistung');
  if (!screen.queryByRole('combobox', { name: 'Show only if…' })) await user.click(screen.getByRole('button', { name: 'Text' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Show only if…' }), 'event_date');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(saveDraft).toHaveBeenCalledWith(5, expect.objectContaining({
    items: [{ kind: 'block', blockId: 7, body: {
      de: '{{#if event_date}}Eigener Text{{/if}}',
      en: '{{#if event_date}}Library text{{/if}}',
    } }],
  })));

  // Removed again: the inherited language goes back to the library, the own text stays.
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Show only if…' }), '');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(saveDraft).toHaveBeenLastCalledWith(5, expect.objectContaining({
    items: [{ kind: 'block', blockId: 7, body: { de: 'Eigener Text' } }],
  })));
});

it('the version history names the publisher and compares a version with the one before', async () => {
  const user = userEvent.setup();
  const published = (n: number, text: string) => ({
    id: 20 + n, version: n, status: n === 2 ? 'published' : 'superseded', title: 'Hochzeitsvertrag', introText: {}, outroText: {},
    contentSha256: 'f'.repeat(64), publishedAt: '2026-09-01T10:00:00Z', createdAt: '2026-09-01T09:00:00Z',
    publishedBy: n === 2 ? { id: 1, username: 'luca' } : null,
    items: [{ kind: 'text', blockId: null, section: 'closing', heading: 'Frist', body: { de: text }, snapshot: {} }],
    attachments: [],
  });
  get.mockResolvedValue({ ...detail(), versions: [published(2, 'Zahlbar in 14 Tagen'), published(1, 'Zahlbar in 30 Tagen')] });
  version.mockImplementation(async (_id: number, n: number) => published(n, n === 2 ? 'Zahlbar in 14 Tagen' : 'Zahlbar in 30 Tagen'));
  renderPage();
  expect(await screen.findByText(/published by luca/)).toBeInTheDocument();
  expect(screen.getByText(/built in/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Compare with previous' }));
  const dialog = await screen.findByRole('dialog', { name: 'Changes in v2' });
  expect(version).toHaveBeenCalledWith(5, 1);
  expect(version).toHaveBeenCalledWith(5, 2);
  expect(dialog).toHaveTextContent('Frist');
  expect(dialog.querySelector('del')).toHaveTextContent('30');
  expect(dialog.querySelector('ins')).toHaveTextContent('14');
});

const twoClauses = () => {
  const d = detail();
  return {
    ...d,
    draft: {
      ...d.draft,
      items: [
        ...d.draft.items,
        { kind: 'text', blockId: null, section: 'closing', heading: 'Schluss', body: { de: 'Ende' }, snapshot: {}, block: null },
      ],
    },
  };
};
const clauseNames = () => screen.getAllByRole('listitem')
  .map((li) => li.getAttribute('data-clause-key') && li.textContent)
  .filter(Boolean)
  .map((text) => (String(text).includes('Leistung') ? 'Leistung' : 'Schluss'));

describe('autosave', () => {
  afterEach(() => vi.useRealTimers());

  it('saves two seconds after the last change and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await screen.findByText('Leistung');
    expect(screen.getByTestId('autosave-status')).toHaveTextContent('No unsaved changes');
    await user.type(screen.getByLabelText('Contract title'), 'X');
    expect(screen.getByTestId('autosave-status')).toHaveTextContent('Unsaved changes');
    expect(saveDraft).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(saveDraft).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(600); });
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft).toHaveBeenCalledWith(5, expect.objectContaining({ lockVersion: 3, title: 'HochzeitsvertragX' }));
    await waitFor(() => expect(screen.getByTestId('autosave-status')).toHaveTextContent(/^Saved /));
  });

  it('stops after a conflict: no further saves until the admin decides', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    saveDraft.mockRejectedValue(apiError('TEMPLATE_CONFLICT', 'conflict'));
    renderPage();
    await screen.findByText('Leistung');
    await user.type(screen.getByLabelText('Contract title'), 'X');
    await act(async () => { vi.advanceTimersByTime(2100); });
    await screen.findByText('Changed by someone else.');
    await user.type(screen.getByLabelText('Contract title'), 'Y');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Contract title')).toHaveValue('HochzeitsvertragXY');
  });
});

it('guards leaving the page only while there are unsaved changes', async () => {
  const user = userEvent.setup();
  const added = vi.spyOn(window, 'addEventListener');
  const removed = vi.spyOn(window, 'removeEventListener');
  renderPage();
  await screen.findByText('Leistung');
  const guards = () => added.mock.calls.filter(([type]) => type === 'beforeunload').length;
  expect(guards()).toBe(0);
  await user.type(screen.getByLabelText('Contract title'), 'X');
  expect(guards()).toBe(1);
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(removed.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true));
  added.mockRestore();
  removed.mockRestore();
});

it('moves clauses with the buttons and Alt+arrows, and Undo restores the order', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(twoClauses());
  renderPage();
  await screen.findByText('Schluss');
  expect(clauseNames()).toEqual(['Leistung', 'Schluss']);

  await user.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
  expect(clauseNames()).toEqual(['Schluss', 'Leistung']);
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(clauseNames()).toEqual(['Leistung', 'Schluss']);
  await user.click(screen.getByRole('button', { name: 'Redo' }));
  expect(clauseNames()).toEqual(['Schluss', 'Leistung']);

  // Alt+↑ on the focused clause's handle.
  const handle = screen.getByRole('button', { name: /Move “Leistung”/ });
  handle.focus();
  await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
  expect(clauseNames()).toEqual(['Leistung', 'Schluss']);

  // Ctrl+Z outside a text field undoes the move.
  (document.activeElement as HTMLElement).blur();
  await user.keyboard('{Control>}z{/Control}');
  expect(clauseNames()).toEqual(['Schluss', 'Leistung']);
});

it('marks where the dry run broke the pages between clauses', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue(twoClauses());
  check.mockResolvedValue({
    ok: true, pageCount: 4, findings: [],
    itemPages: [{ position: 1, firstPage: 1, lastPage: 2 }, { position: 2, firstPage: 3, lastPage: 3 }],
  });
  renderPage();
  await screen.findByText('Schluss');
  await user.click(screen.getByRole('button', { name: 'Check' }));
  expect(await screen.findByText('page 3')).toBeInTheDocument();
  expect(screen.getByText('pages 1–2')).toBeInTheDocument();

  await user.type(screen.getByLabelText('Contract title'), 'X');
  expect(screen.getByText(/page 3 · before your latest changes/)).toBeInTheDocument();
});

it('offers a newer system version without applying it, and adds only the new clauses on request', async () => {
  const user = userEvent.setup();
  get.mockResolvedValue({
    ...detail(),
    lineage: { sourceTemplateId: 1, sourceName: 'Standard contract', sourceIsSystem: true, sourceVersion: 1, latestSourceVersion: 2, updateAvailable: true },
  });
  version.mockImplementation(async (_id: number, n: number) => ({
    id: 40 + n, version: n, status: 'published', title: '', introText: {}, outroText: {}, contentSha256: null, publishedAt: null,
    items: [
      { kind: 'block', blockId: 7, section: 'scope', heading: null, body: {}, snapshot: { de: 'Bibliothekstext' }, block: { slug: 's', name: 'Leistung', isActive: true, bodies: {} } },
      ...(n === 2 ? [{ kind: 'block', blockId: 9, section: 'closing', heading: null, body: {}, snapshot: { de: 'Neu' }, block: { slug: 'n', name: 'Neue Klausel', isActive: true, bodies: {} } }] : []),
    ],
    attachments: [],
  }));
  renderPage();
  expect(await screen.findByText(/The system template was updated \(v1 → v2\)/)).toBeInTheDocument();
  expect(screen.queryByText('Neue Klausel')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Add the new clauses to my draft' }));
  await waitFor(() => expect(saveDraft).toHaveBeenCalledWith(5, expect.objectContaining({
    sourceVersionNumber: 2,
    items: [{ kind: 'block', blockId: 7, body: {} }, { kind: 'block', blockId: 9, body: {} }],
  })));
  expect(screen.getByText('Neue Klausel')).toBeInTheDocument();
});
