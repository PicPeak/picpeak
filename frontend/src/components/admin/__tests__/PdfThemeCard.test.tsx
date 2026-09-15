/**
 * PDF theme card (#1445): per-document scopes, inherited values, saving,
 * resetting and previewing with unsaved settings.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Resolve against the real en.json so a missing key shows up as a failure.
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

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const list = vi.fn();
const save = vi.fn();
const previewUrl = vi.fn();
vi.mock('../../../services/pdfThemes.service', () => ({
  pdfThemesService: {
    list: (...args: unknown[]) => list(...args),
    save: (...args: unknown[]) => save(...args),
    previewUrl: (...args: unknown[]) => previewUrl(...args),
  },
}));

import { PdfThemeCard } from '../PdfThemeCard';

const resolved = (scope: string, extra: Record<string, unknown> = {}) => ({
  scope,
  fontFamily: null,
  colors: { text: '#000000', muted: '#666666', subtle: '#888888', accent: '#000000', rule: '#888888' },
  titleSize: scope === 'contract' ? 18 : 20,
  footer: { mode: scope === 'contract' ? 'none' : 'address', text: '' },
  pageNumbers: 'bottom-right',
  foldingMarks: 'none',
  ...extra,
});

const themes = {
  themes: [
    { scope: 'default', settings: {}, updatedAt: null, resolved: resolved('default') },
    { scope: 'quote', settings: {}, updatedAt: null, resolved: resolved('quote') },
    { scope: 'invoice', settings: {}, updatedAt: null, resolved: resolved('invoice') },
    { scope: 'contract', settings: { titleSize: 19 }, updatedAt: null, resolved: resolved('contract', { titleSize: 19 }) },
  ],
  fontFamilies: ['Inter', 'Jost'],
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PdfThemeCard /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(themes);
  save.mockResolvedValue(themes);
  previewUrl.mockResolvedValue('blob:preview');
});

it('saves only what was changed for the chosen document type', async () => {
  const user = userEvent.setup();
  renderCard();

  await user.click(await screen.findByRole('button', { name: 'Quotes' }));
  fireEvent.change(screen.getByLabelText(/Title and headings/), { target: { value: '#123456' } });
  await user.selectOptions(screen.getByLabelText('Font'), 'Jost');
  await user.click(screen.getByRole('button', { name: 'Save theme' }));

  await waitFor(() => expect(save).toHaveBeenCalledWith('quote', { colors: { accent: '#123456' }, fontFamily: 'Jost' }));
});

it('shows inherited values and resets a scope', async () => {
  const user = userEvent.setup();
  renderCard();

  await user.click(await screen.findByRole('button', { name: 'Contracts' }));
  expect(screen.getByLabelText('Title size')).toHaveValue('19');
  expect(screen.getByRole('option', { name: 'Inherit (No footer)' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Reset to inherited' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('contract', {}));
});

it('previews with the unsaved settings', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  renderCard();

  await user.selectOptions(await screen.findByLabelText('Footer'), 'custom');
  await user.type(screen.getByLabelText('Footer text'), 'Studio Test');
  await user.click(screen.getByRole('button', { name: 'Preview PDF' }));

  await waitFor(() => expect(previewUrl).toHaveBeenCalledWith('default', { footer: { mode: 'custom', text: 'Studio Test' } }));
  expect(open).toHaveBeenCalledWith('blob:preview', '_blank', 'noopener');
});
