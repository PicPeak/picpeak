/**
 * The password page sets the instance's default language for a visitor who
 * is not logged in. A gallery in visitor-language mode (issue 2550) follows
 * the visitor's own language instead, so the page must leave it alone there;
 * off and bilingual keep the old behaviour. The page title follows the mode.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const state = vi.hoisted(() => ({
  info: {} as Record<string, unknown>,
  language: 'en',
  changeLanguage: vi.fn(),
}));

vi.mock('../../hooks/useShowAgbLink', () => ({ useShowAgbLink: () => false }));
vi.mock('../../contexts', () => ({
  useGalleryAuth: () => ({ isAuthenticated: false, isLoading: false, event: null, login: vi.fn() }),
  useTheme: () => ({ setTheme: vi.fn() }),
}));
vi.mock('../../hooks/useGallery', () => ({
  useGalleryInfo: () => ({ data: state.info, isLoading: false, error: null }),
}));
const settings = { data: { default_language: 'de' }, isLoading: false };
vi.mock('../../hooks/usePublicSettings', () => ({ usePublicSettings: () => settings }));
vi.mock('../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: () => '19 September 2026', formatExpiry: () => '' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : _key),
    i18n: { language: state.language, resolvedLanguage: state.language, changeLanguage: state.changeLanguage },
  }),
}));
vi.mock('../../components/gallery', () => ({ GalleryView: () => <div data-testid="gallery-view" /> }));
vi.mock('../../components/gallery/GallerySkeleton', () => ({ GallerySkeleton: () => <div data-testid="gallery-skeleton" /> }));
vi.mock('../../components/common', () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: () => <input />,
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
  ReCaptcha: () => null,
  CMSContentBlock: ({ slug }: { slug: string }) => <div data-testid={`cms-${slug}`} />,
  PoweredBy: () => null,
}));
vi.mock('../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../services', () => ({ galleryService: { resolveIdentifier: vi.fn() } }));

import { GalleryPage } from '../GalleryPage';

function open(mode: 'off' | 'visitor' | 'bilingual' | undefined, language = 'en') {
  state.language = language;
  state.info = {
    event_name: 'Hochzeit', event_type: 'wedding', event_date: '2026-06-05', expires_at: '2027-06-05',
    requires_password: true, allow_downloads: true,
    ...(mode ? {
      text_language_mode: mode, text_primary_language: 'de', text_secondary_language: mode === 'bilingual' ? 'en' : null,
      ...(mode !== 'off' ? { translations: { event_name: { en: 'Wedding' } } } : {}),
    } : {}),
  };
  render(
    <MemoryRouter initialEntries={['/gallery/wedding-2026']}>
      <Routes><Route path="/gallery/:slug/:token?" element={<GalleryPage />} /></Routes>
    </MemoryRouter>,
  );
}

const title = () => screen.getByRole('heading', { level: 1 });

afterEach(() => {
  cleanup();
  state.changeLanguage.mockClear();
});

describe('GalleryPage language on the password page', () => {
  it.each([['off'], ['bilingual'], [undefined]] as const)('mode %s: switches to the default language, as before', (mode) => {
    open(mode);
    expect(state.changeLanguage).toHaveBeenCalledWith('de');
  });

  it('visitor mode: keeps the visitor\'s language and shows the title in it', () => {
    open('visitor', 'en');
    expect(state.changeLanguage).not.toHaveBeenCalled();
    expect(title().textContent).toBe('Wedding');
  });

  it('bilingual: the title in both languages', () => {
    open('bilingual', 'en');
    expect(title().firstChild?.textContent).toBe('Hochzeit');
    expect(title().querySelector('[data-gallery-text="secondary"]')?.textContent).toBe('Wedding');
  });
});
