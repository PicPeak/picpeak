/**
 * The CMS page editor saves with the page's save bar; there is no autosave.
 * A refetch of the page list while the page has unsaved edits — the logo
 * upload invalidates it — must not replace the typed text with the stored
 * version: only the new logo comes in, and the page stays unsaved.
 */
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }),
}));
vi.mock('../../../components/admin/CMSEditor', () => ({ CMSEditor: () => <div>editor</div> }));

const stored = { slug: 'impressum', title_en: 'Imprint', title_de: 'Impressum', content_en: '<p>x</p>', content_de: '<p>x</p>', logo_url: null as string | null };
let current = { ...stored };
let calls = 0;
vi.mock('../../../services/cms.service', () => ({
  cmsService: {
    getPages: () => { calls += 1; return Promise.resolve([{ ...current }]); },
    updatePage: vi.fn(),
    uploadPageLogo: vi.fn(),
    clearPageLogo: vi.fn(),
  },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: {
    getAllSettings: () => Promise.resolve({}),
    getPublicSiteDefaults: () => Promise.resolve({ html: '', css: '' }),
    updatePublicSite: vi.fn(),
    resetPublicSite: vi.fn(),
  },
}));

import { CMSPage } from '../CMSPage';

it('keeps the typed title when the page list refetches with a new logo', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><CMSPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  const title = await screen.findByDisplayValue('Imprint');
  fireEvent.change(title, { target: { value: 'Imprint, edited' } });

  current = { ...stored, logo_url: '/logos/new.png' };
  await act(async () => { await client.invalidateQueries({ queryKey: ['cms-pages'] }); });

  await waitFor(() => expect(calls).toBe(2));
  await waitFor(() => expect(screen.getByDisplayValue('Imprint, edited')).toBeInTheDocument());
  expect(screen.queryByDisplayValue('Imprint')).not.toBeInTheDocument();
});
