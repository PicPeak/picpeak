/**
 * The single-page landing editor moved into the website builder (issue
 * 2618). While the website is off, the CMS tab edits every CMS page, legal
 * and system pages alike; while it is on, the builder's Pages panel edits
 * them all, and the tab only says so and links each one there.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : (fb as { defaultValue?: string })?.defaultValue ?? k), i18n: { language: 'en' } }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }),
}));
vi.mock('../../../components/admin/CMSEditor', () => ({ CMSEditor: () => <div>editor</div> }));
vi.mock('../../../services/cms.service', async (original) => ({
  ...(await original<typeof import('../../../services/cms.service')>()),
  cmsService: { getPages: () => Promise.resolve(PAGES), updatePage: vi.fn(), uploadPageLogo: vi.fn(), clearPageLogo: vi.fn() },
}));
const SLUGS = ['impressum', 'datenschutz', 'agb', 'not-found', 'gallery-not-found'];
const page = (slug: string) => ({ id: slug.length, slug, title_en: `Title ${slug}`, title_de: slug, content_en: '', content_de: '', logo_url: null, use_external_url: false, external_url: null, updated_at: '' });
const PAGES = SLUGS.map(page);
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

it('while the website is off, says where the landing page is edited now and links to the switch for it', async () => {
  flagOn.mockReturnValue(false);
  renderPage();
  expect(await screen.findByText(/landing page is edited under Website now/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open Features' })).toHaveAttribute('href', '/admin/settings?tab=features');
});

it('edits every CMS page here while the website is off', async () => {
  flagOn.mockReturnValue(false);
  renderPage();
  for (const slug of SLUGS) expect(await screen.findByText(`/${slug}`)).toBeInTheDocument();
  expect(screen.getAllByText('editor').length).toBeGreaterThan(0);
  expect(screen.queryByText(/managed under Website/)).toBeNull();
});

it('while the website is on, links every page to the builder instead of a second editor', async () => {
  flagOn.mockReturnValue(true);
  renderPage();
  expect(await screen.findByText(/managed under Website/)).toBeInTheDocument();
  for (const slug of SLUGS) {
    expect(screen.getByRole('link', { name: new RegExp(`Title ${slug}`) })).toHaveAttribute('href', `/admin/website?panel=pages&cms=${slug}`);
  }
  expect(screen.queryByText('editor')).toBeNull();
});

it('shows no stray 0 for a flag SQLite stores as a number', async () => {
  flagOn.mockReturnValue(false);
  PAGES[0] = { ...PAGES[0], use_external_url: 0 as unknown as boolean };
  const { container } = renderPage();
  await screen.findAllByText('editor');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  while (walker.nextNode()) texts.push((walker.currentNode.nodeValue || '').trim());
  expect(texts).not.toContain('0');
});
