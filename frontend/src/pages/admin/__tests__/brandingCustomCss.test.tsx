import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GALLERY_THEME_PRESETS } from '../../../types/theme.types';

const CSS = '.gallery-premium-footer p:first-child { display: none; }';
const savedTheme = { ...GALLERY_THEME_PRESETS.galleryPremium.config, customCss: CSS };

// --- mocks -----------------------------------------------------------------
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) })
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../services/settings.service', async () => {
  const actual = await vi.importActual<any>('../../../services/settings.service');
  return {
    ...actual,
    settingsService: {
      ...actual.settingsService,
      getSettingsByType: vi.fn(async (type: string) =>
        type === 'theme' ? { theme_config: savedTheme } : {}
      ),
      getAllSettings: vi.fn(async () => ({ thumbnail_width: '800', thumbnail_height: '800' })),
      updateTheme: vi.fn(async () => undefined),
      updateBranding: vi.fn(async () => undefined),
    },
  };
});

vi.mock('../../../services/fonts.service', () => ({
  fontsService: { list: vi.fn(async () => []) },
  extractFamilyName: (s: string) => s,
}));

vi.mock('../../../services/businessProfile.service', () => ({
  businessProfileService: { get: vi.fn(async () => ({ profile: {} })), update: vi.fn() },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  PUBLIC_SETTINGS_QUERY_KEY: ['public-settings'],
  usePublicSettings: () => ({ data: { branding_force_color_mode: null } }),
}));

vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {} }),
  useFeatureEnabled: () => false,
}));

// Heavy/unrelated children — stub to keep the test focused on the CSS textarea.
vi.mock('../../../components/admin/CustomerDashboardBrandingCard', () => ({
  CustomerDashboardBrandingCard: () => null,
}));
vi.mock('../../../components/admin/PdfTypographyCard', () => ({
  PdfTypographyCard: () => null,
}));
vi.mock('../../../components/admin', async () => {
  const actual = await vi.importActual<any>('../../../components/admin');
  return { ...actual, GalleryPreview: () => null };
});

import { BrandingPage } from '../BrandingPage';
import { ThemeProvider } from '../../../contexts/ThemeContext';

describe('BrandingPage custom CSS persistence (#645)', () => {
  beforeEach(() => localStorage.clear());

  it('shows the saved custom CSS in the textarea on load for a Gallery Premium theme', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <BrandingPage />
        </ThemeProvider>
      </QueryClientProvider>
    );

    const textarea = (await screen.findByPlaceholderText(
      '/* Add custom CSS here */'
    )) as HTMLTextAreaElement;

    await waitFor(() => expect(textarea.value).toBe(CSS));
  });
});
