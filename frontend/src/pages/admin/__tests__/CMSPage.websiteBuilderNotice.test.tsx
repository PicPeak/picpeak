/**
 * With the website builder on (issue 2618) the single-page site below is only
 * the fallback until a website is published; the CMS page says so and links
 * to the builder.
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
  cmsService: { getPages: () => Promise.resolve([]), updatePage: vi.fn(), uploadPageLogo: vi.fn(), clearPageLogo: vi.fn() },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: {
    getAllSettings: () => Promise.resolve({}),
    getPublicSiteDefaults: () => Promise.resolve({ html: '', css: '' }),
    updatePublicSite: vi.fn(),
    resetPublicSite: vi.fn(),
  },
}));
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

it('points to the website builder while it is on', async () => {
  flagOn.mockReturnValue(true);
  renderPage();
  const link = await screen.findByRole('link', { name: 'Open the website builder' });
  expect(link.getAttribute('href')).toBe('/admin/website');
});

it('says nothing about it while it is off', async () => {
  flagOn.mockReturnValue(false);
  renderPage();
  await screen.findAllByText('editor');
  expect(screen.queryByRole('link', { name: 'Open the website builder' })).toBeNull();
});
