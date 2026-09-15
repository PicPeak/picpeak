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

const apiError = (code: string, error: string) => Object.assign(new Error(error), { response: { data: { code, error } } });

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

it('lists every problem the server found when publishing', async () => {
  const user = userEvent.setup();
  publish.mockRejectedValue(apiError('TEMPLATE_INVALID',
    '"Leistung" is archived in the clause library · Unknown placeholders: {{custmer}}'));
  renderPage();
  await screen.findByText('Leistung');
  await user.click(screen.getByRole('button', { name: 'Publish' }));

  await waitFor(() => expect(publish).toHaveBeenCalledWith(5, 4));
  expect(await screen.findByText('"Leistung" is archived in the clause library')).toBeInTheDocument();
  expect(screen.getByText('Unknown placeholders: {{custmer}}')).toBeInTheDocument();
});
