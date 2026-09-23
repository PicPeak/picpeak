/**
 * A gallery with no password auto-logs the visitor in with an empty password.
 * That request mints a plain GUEST token and, server-side, overwrites the
 * `gallery_token_<slug>` cookie — so firing it while a real session already
 * exists destroys that session.
 *
 * It used to fire on `!isAuthenticated` alone, which stays false until
 * GalleryAuthContext's `/auth/session` restore resolves. `/info` answers
 * first, the effect runs, and the empty-password login lands before the
 * context can report the client session it had just confirmed.
 *
 * The guard is now the context's own `isLoading`: nothing may auto-login until
 * the session probe has settled (fork survey A3 / #1563).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const login = vi.fn().mockResolvedValue(undefined);

let auth = {
  isAuthenticated: false,
  isLoading: true,
  event: null as unknown,
  login,
};

vi.mock('../../contexts', () => ({
  useGalleryAuth: () => auth,
  useTheme: () => ({ setTheme: vi.fn() }),
}));

vi.mock('../../hooks/useGallery', () => ({
  useGalleryInfo: () => ({
    data: {
      event_name: 'Hoa Wedding',
      event_type: 'wedding',
      event_date: '2026-09-19',
      expires_at: '2027-09-19',
      requires_password: false,
      allow_downloads: true,
    },
    isLoading: false,
    error: null,
  }),
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
  CMSContentBlock: () => null,
  PoweredBy: () => null,
}));

vi.mock('../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../services', () => ({ galleryService: { resolveIdentifier: vi.fn() } }));

import { GalleryPage } from '../GalleryPage';

const SLUG = 'wedding-hoa-wedding-2026-09-19';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
      <Routes>
        <Route path="/gallery/:slug" element={<GalleryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  login.mockClear();
  auth = { isAuthenticated: false, isLoading: true, event: null, login };
});

afterEach(cleanup);

describe('GalleryPage — passwordless auto-login on a public gallery', () => {
  it('waits for the session restore instead of overwriting a client session with a guest one', async () => {
    const { rerender } = renderPage();

    // Session probe still in flight: /info has answered, isAuthenticated is
    // still false — the window the bug used to fire in.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(login).not.toHaveBeenCalled();

    auth = {
      isAuthenticated: true,
      isLoading: false,
      event: { id: 5, event_name: 'Hoa Wedding' },
      login,
    };
    rerender(
      <MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
        <Routes>
          <Route path="/gallery/:slug" element={<GalleryPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(login).not.toHaveBeenCalled();
  });

  it('still opens a public gallery for a visitor with no session at all', async () => {
    const { rerender } = renderPage();

    auth = { isAuthenticated: false, isLoading: false, event: null, login };
    rerender(
      <MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
        <Routes>
          <Route path="/gallery/:slug" element={<GalleryPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(login).toHaveBeenCalledWith(SLUG, ''));
  });
});
