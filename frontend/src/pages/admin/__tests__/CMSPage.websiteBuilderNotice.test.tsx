/**
 * The single-page landing editor moved into the website builder (issue
 * 2618). The CMS tab keeps the legal pages while the website is off; while it
 * is on, they are edited in the builder's Pages panel, which the tab links to,
 * and the tab keeps the other CMS pages.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }),
}));
vi.mock('../../../components/admin/CMSEditor', () => ({ CMSEditor: () => <div>editor</div> }));
vi.mock('../../../services/cms.service', () => ({
  cmsService: { getPages: () => Promise.resolve(PAGES), updatePage: vi.fn(), uploadPageLogo: vi.fn(), clearPageLogo: vi.fn() },
  LEGAL_PAGE_SLUGS: ['impressum', 'datenschutz', 'agb'],
}));
const page = (slug: string) => ({ id: slug.length, slug, title_en: slug, title_de: slug, content_en: '', content_de: '', logo_url: null, use_external_url: false, external_url: null, updated_at: '' });
const PAGES = [page('impressum'), page('datenschutz'), page('gallery-not-found')];
const flagOn = vi.fn(() => false);
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: () => flagOn() }));

import { CMSPage } from '../CMSPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><CMSPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

it('has no landing page editor any more', async () => {
  flagOn.mockReturnValue(false);
  renderPage();
  await screen.findAllByText('editor');
  expect(screen.queryByText('settings.publicSite.title')).toBeNull();
});

it('keeps every CMS page, the legal ones too, while the website is off', async () => {
  flagOn.mockReturnValue(false);
  renderPage();
  expect(await screen.findByText('/impressum')).toBeInTheDocument();
  expect(screen.getByText('/gallery-not-found')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Edit them in Website › Pages' })).toBeNull();
});

it('links the legal pages to the website builder while it is on, and keeps the others here', async () => {
  flagOn.mockReturnValue(true);
  renderPage();
  const link = await screen.findByRole('link', { name: 'Edit them in Website › Pages' });
  expect(link.getAttribute('href')).toBe('/admin/website?panel=pages');
  expect(await screen.findByText('/gallery-not-found')).toBeInTheDocument();
  expect(screen.queryByText('/impressum')).toBeNull();
});
