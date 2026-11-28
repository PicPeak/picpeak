/**
 * Multilingual gallery texts in the gallery view (issue 2550): the title,
 * welcome message and category names the layouts receive follow the mode
 * and the visitor's language; bilingual mode hands the header its second
 * line; the language switcher shows only when the gallery has texts in more
 * than one language.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GallerySecondaryText } from '../../../hooks/useGalleryText';

type PhotosResult = { data: unknown; isLoading: boolean; error: unknown; refetch: () => void };
let photos: PhotosResult;

const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false, viaClientPin: false,
    enterClientMode: () => {}, leaveClientMode: () => {} },
  theme: { setTheme: () => {}, theme: { galleryLayout: 'grid' } as { galleryLayout: string } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
}));

vi.mock('../../../contexts', () => ({
  useGalleryAuth: () => stable.auth,
  useTheme: () => stable.theme,
}));
vi.mock('../../../hooks/useGallery', () => ({
  useGalleryPhotos: () => photos,
  useDownloadAllPhotos: () => stable.download,
}));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => stable.settings }));
vi.mock('../../../hooks/useWatermarkSettings', () => ({ useWatermarkSettings: () => stable.watermark }));
vi.mock('../../../hooks/useGalleryCustomCss', () => ({ useGalleryCustomCss: () => undefined }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: stable.t, i18n: stable.i18n }),
}));
vi.mock('../../../services/analytics.service', () => ({
  analyticsService: { track: vi.fn(), trackGalleryEvent: vi.fn(), trackSearch: vi.fn(), trackExpirationWarning: vi.fn() },
}));
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPeople: vi.fn().mockResolvedValue({ people: [] }) },
}));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../../../features/album-products/GalleryProductPanel', () => ({ GalleryProductPanel: () => null }));
vi.mock('../../../features/print-sales/GalleryPrintShop', () => ({
  PrintSalesProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  PrintShopEntry: () => null,
}));

// The header draws the title it is handed, its second line from the context,
// and the header slot (where the switcher goes).
vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children, event, headerExtra }: { children?: React.ReactNode; event: { event_name: string }; headerExtra?: React.ReactNode }) => (
    <div data-testid="layout">
      <h1 data-testid="title">{event.event_name}<GallerySecondaryText kind="title" /></h1>
      <div data-testid="header-extra">{headerExtra}</div>
      {children}
    </div>
  ),
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: ({ welcomeMessage, categories, beforeGrid, photos: shown }: {
    welcomeMessage?: string; categories?: Array<{ name: string }>; photos?: Array<{ category_name?: string }>;
    beforeGrid?: React.ReactNode | ((photos: unknown[]) => React.ReactNode);
  }) => (
    <div data-testid="grid" data-categories={(categories || []).map((c) => c.name).join('|')}
      data-photo-categories={(shown || []).map((p) => p.category_name ?? '').join('|')}>
      <div data-testid="before-grid">{typeof beforeGrid === 'function' ? beforeGrid(shown || []) : beforeGrid}</div>
      <p data-testid="welcome">{welcomeMessage}<GallerySecondaryText kind="welcome" /></p>
    </div>
  ),
}));
vi.mock('../GalleryCategoryChips', () => ({
  GalleryCategoryChips: ({ categories }: { categories: Array<{ name: string }> }) => (
    <div data-testid="chips">{categories.map((c) => c.name).join('|')}</div>
  ),
}));

import { GalleryView } from '../GalleryView';

const contextEvent = { id: 1, event_name: 'Hochzeit', welcome_message: 'Willkommen', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

function show(mode: 'off' | 'visitor' | 'bilingual', { translated = true, language = 'en' } = {}) {
  stable.i18n.language = language;
  stable.i18n.resolvedLanguage = language;
  const texts = translated && mode !== 'off';
  photos = {
    data: {
      event: {
        ...contextEvent,
        text_language_mode: mode,
        text_primary_language: mode === 'off' ? null : 'de',
        text_secondary_language: mode === 'bilingual' ? 'en' : null,
        ...(texts ? { translations: { event_name: { en: 'Wedding' }, welcome_message: { en: 'Welcome' } } } : {}),
      },
      categories: [{ id: 3, name: 'Trauung', slug: 'trauung', is_global: false, ...(texts ? { translations: { name: { en: 'Ceremony' } } } : {}) }],
      photos: [{ id: 7, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/a-t.jpg', type: 'photo', size: 1, uploaded_at: '2026-09-19T10:00:00Z', category_id: 3, category_name: 'Trauung' }],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={contextEvent} />
    </QueryClientProvider>,
  );
}

const switcher = () => screen.queryByRole('button', { name: /^Language:/ });

afterEach(() => {
  cleanup();
  stable.theme.theme = { galleryLayout: 'grid' };
});

describe('GalleryView multilingual texts', () => {
  it('off: the default texts and no switcher', () => {
    show('off');
    expect(screen.getByTestId('title').textContent).toBe('Hochzeit');
    expect(screen.getByTestId('welcome').textContent).toBe('Willkommen');
    expect(switcher()).toBeNull();
  });

  it('visitor: the visitor language, and a switcher for the gallery languages', () => {
    show('visitor', { language: 'en' });
    expect(screen.getByTestId('title').textContent).toBe('Wedding');
    expect(screen.getByTestId('welcome').textContent).toBe('Welcome');
    expect(screen.getByTestId('chips').textContent).toBe('Ceremony');
    expect(screen.getByTestId('header-extra').contains(switcher())).toBe(true);
  });

  it('visitor: a language without texts falls back to the default texts', () => {
    show('visitor', { language: 'fr' });
    expect(screen.getByTestId('title').textContent).toBe('Hochzeit');
    expect(screen.getByTestId('chips').textContent).toBe('Trauung');
  });

  it('visitor: no switcher while the texts are in one language only', () => {
    show('visitor', { translated: false });
    expect(switcher()).toBeNull();
  });

  it('bilingual: primary title and welcome with the secondary below; names in the primary only', () => {
    show('bilingual', { language: 'en' });
    const title = screen.getByTestId('title');
    expect(title.firstChild?.textContent).toBe('Hochzeit');
    expect(title.querySelector('[data-gallery-text="secondary"]')?.textContent).toBe('Wedding');
    expect(screen.getByTestId('welcome').querySelector('[data-gallery-text="secondary"]')?.textContent).toBe('Welcome');
    expect(screen.getByTestId('chips').textContent).toBe('Trauung');
  });

  it.each(['gallery-premium', 'gallery-story', 'gallery-folio'])('%s: the switcher sits in the toolbox the layout draws', (layout) => {
    stable.theme.theme = { galleryLayout: layout };
    show('visitor');
    expect(screen.getByTestId('before-grid').contains(switcher())).toBe(true);
    // Story's scenes are its categories: they arrive resolved too.
    if (layout === 'gallery-story') expect(screen.getByTestId('grid').dataset.categories).toBe('Ceremony');
    // Premium's tabs, Story's scene titles, captions and search read the
    // photo's own category name: it follows the categories.
    expect(screen.getByTestId('grid').dataset.photoCategories).toBe('Ceremony');
  });
});
