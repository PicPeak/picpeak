/**
 * A gallery link sent before the gallery was renamed carries the old slug.
 * /info answers it with a 301 whose JSON body names the new slug; the page
 * used to treat that like any other error and show "gallery not found".
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const OLD_SLUG = 'wedding-old-name-2026-06-05';
const NEW_SLUG = 'wedding-new-name-2026-06-05';
const TOKEN = 'a'.repeat(32);

vi.mock('../../contexts', () => ({
  useGalleryAuth: () => ({ isAuthenticated: true, isLoading: false, event: { id: 5, event_name: 'New Name' }, login: vi.fn() }),
  useTheme: () => ({ setTheme: vi.fn() }),
}));

const infoCalls: Array<string | undefined> = [];
vi.mock('../../hooks/useGallery', () => ({
  useGalleryInfo: (slug?: string) => {
    infoCalls.push(slug);
    if (slug === 'wedding-old-name-2026-06-05') {
      return {
        data: undefined,
        isLoading: false,
        error: { response: { status: 301, data: { redirect: true, newSlug: 'wedding-new-name-2026-06-05' } } },
      };
    }
    return {
      data: {
        event_name: 'New Name', event_type: 'wedding', event_date: '2026-06-05',
        expires_at: '2027-06-05', requires_password: true, allow_downloads: true,
      },
      isLoading: false,
      error: null,
    };
  },
}));

vi.mock('../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: {}, isLoading: false }),
}));

vi.mock('../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: () => '19 September 2026' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock('../../components/gallery', () => ({
  GalleryView: () => <div data-testid="gallery-view" />,
}));

vi.mock('../../components/gallery/GallerySkeleton', () => ({
  GallerySkeleton: () => <div data-testid="gallery-skeleton" />,
}));

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

function Where() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

afterEach(() => {
  cleanup();
  infoCalls.length = 0;
});

describe('GalleryPage — renamed gallery', () => {
  it('replaces an old-slug link with the new slug, keeping token and query', async () => {
    render(
      <MemoryRouter initialEntries={[`/gallery/${OLD_SLUG}/${TOKEN}?photo=42`]}>
        <Routes>
          <Route path="/gallery/:slug/:token?" element={<><GalleryPage /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('gallery-view')).toBeTruthy());
    expect(screen.getByTestId('location').textContent).toBe(`/gallery/${NEW_SLUG}/${TOKEN}?photo=42`);
    expect(infoCalls).toContain(NEW_SLUG);
    expect(screen.queryByTestId('cms-gallery-not-found')).toBeNull();
  });
});
