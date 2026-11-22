/**
 * A browser that refuses Web Storage (blocked site data, Safari with storage
 * disabled) throws a SecurityError on the `localStorage` / `sessionStorage`
 * getter itself. The gallery
 * session must still come up from the server cookie for this page view.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const SLUG = 'summer-party';

vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: { valid: true, type: 'gallery', eventSlug: 'summer-party', accessLevel: 'client' } })),
  },
}));

vi.mock('../../services', () => ({
  authService: { verifyGalleryPassword: vi.fn(), shareLinkLogin: vi.fn(), galleryLogout: vi.fn() },
  galleryService: {
    getGalleryPhotos: vi.fn(async () => ({ event: { id: 7, event_name: 'Summer party', slug: 'summer-party' } })),
    verifyToken: vi.fn(),
  },
}));

import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';

let auth: ReturnType<typeof useGalleryAuth> | null = null;

const Probe: React.FC = () => {
  auth = useGalleryAuth();
  return null;
};

const originals = {
  localStorage: Object.getOwnPropertyDescriptor(window, 'localStorage')!,
  sessionStorage: Object.getOwnPropertyDescriptor(window, 'sessionStorage')!,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'localStorage', originals.localStorage);
  Object.defineProperty(window, 'sessionStorage', originals.sessionStorage);
  auth = null;
});

describe('GalleryAuthProvider without usable storage', () => {
  it('authenticates and logs out when the storage getters throw', async () => {
    const denied = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      Object.defineProperty(window, name, { configurable: true, get: denied });
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
        <QueryClientProvider client={new QueryClient()}><GalleryAuthProvider>
          <Probe />
        </GalleryAuthProvider></QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(auth).toMatchObject({ isAuthenticated: true, isLoading: false }));
    expect(auth!.accessLevel).toBe('client');
    expect(auth!.event).toMatchObject({ id: 7 });

    auth!.logout();
    await waitFor(() => expect(auth).toMatchObject({ isAuthenticated: false }));
  });
});
