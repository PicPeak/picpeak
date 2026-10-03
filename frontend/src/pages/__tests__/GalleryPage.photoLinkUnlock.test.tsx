/**
 * Link to a single photo (issue 1733) on a password-protected gallery: the
 * password form renders in place, with no redirect, so `?photo=` survives the
 * unlock and the gallery view mounts with it still in the address bar. The
 * prompt always comes first — the param never opens anything by itself.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const login = vi.fn().mockResolvedValue(undefined);

let auth = {
  isAuthenticated: false,
  isLoading: false,
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
      requires_password: true,
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
  GalleryView: () => <div data-testid="gallery-view">{window.location.search}</div>,
}));

vi.mock('../../components/gallery/GallerySkeleton', () => ({
  GallerySkeleton: () => <div data-testid="gallery-skeleton" />,
}));

vi.mock('../../components/common', () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: () => <input data-testid="password-input" />,
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
  ReCaptcha: () => null,
  CMSContentBlock: () => null,
  PoweredBy: () => null,
}));

vi.mock('../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../services', () => ({ galleryService: { resolveIdentifier: vi.fn() } }));

import { GalleryPage } from '../GalleryPage';

const SLUG = 'wedding-hoa-wedding-2026-09-19';
const original = window.location.href;

function page() {
  return (
    <MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
      <Routes>
        <Route path="/gallery/:slug" element={<GalleryPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  login.mockClear();
  auth = { isAuthenticated: false, isLoading: false, event: null, login };
  window.history.replaceState({}, '', `/gallery/${SLUG}?photo=42`);
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', original);
});

describe('GalleryPage — ?photo= on a password-protected gallery (issue 1733)', () => {
  it('shows the password prompt first and hands the param on to the gallery after the unlock', async () => {
    const { rerender } = render(page());

    // Locked: the form, not the gallery, and nothing logged in on its own.
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-view')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(login).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?photo=42');

    // Unlocked in place: the view mounts with the photo still in the URL.
    auth = { isAuthenticated: true, isLoading: false, event: { id: 5, event_name: 'Hoa Wedding' }, login };
    rerender(page());
    expect(screen.getByTestId('gallery-view')).toHaveTextContent('?photo=42');
    expect(window.location.search).toBe('?photo=42');
  });
});
