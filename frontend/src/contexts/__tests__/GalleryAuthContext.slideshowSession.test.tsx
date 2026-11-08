/**
 * A browser that opened the Live Slideshow link holds a display-only gallery
 * session for that slug. An older backend still reports it as valid; the page
 * must not keep it as the guest login (every rating, comment, favourite and
 * download would be refused) but log in through the share link instead.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const SLUG = 'summer-party';
const SHARE = 'share-token-abc';

vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: { valid: true, type: 'gallery', eventSlug: 'summer-party', accessLevel: 'slideshow' } })),
  },
}));

vi.mock('../../services', () => ({
  authService: {
    verifyGalleryPassword: vi.fn(),
    shareLinkLogin: vi.fn(async () => ({
      token: 'fresh-guest-session',
      event: { id: 7, event_name: 'Summer party', slug: 'summer-party' },
    })),
  },
  galleryService: {
    getGalleryPhotos: vi.fn(async () => ({ event: { id: 7, event_name: 'Summer party', slug: 'summer-party' } })),
    verifyToken: vi.fn(async () => ({ valid: true })),
  },
}));

vi.mock('../../utils/cleanupGalleryAuth', () => ({ cleanupOldGalleryAuth: vi.fn() }));

import { authService, galleryService } from '../../services';
import { getGalleryToken } from '../../utils/galleryAuthStorage';
import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';

let state: { isAuthenticated: boolean; isLoading: boolean } = { isAuthenticated: false, isLoading: true };

const Probe: React.FC = () => {
  const { isAuthenticated, isLoading } = useGalleryAuth();
  state = { isAuthenticated, isLoading };
  return null;
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe('GalleryAuthProvider: slideshow session on the share link', () => {
  it('replaces a slideshow session with a share-link guest login', async () => {
    render(
      <MemoryRouter initialEntries={[`/gallery/${SLUG}/${SHARE}`]}>
        <QueryClientProvider client={new QueryClient()}><GalleryAuthProvider>
          <Probe />
        </GalleryAuthProvider></QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(state).toMatchObject({ isAuthenticated: true, isLoading: false }));
    expect(galleryService.verifyToken).toHaveBeenCalledWith(SLUG, SHARE);
    expect(authService.shareLinkLogin).toHaveBeenCalledWith(SLUG, SHARE);
    expect(getGalleryToken(SLUG)).toBe('fresh-guest-session');
  });
});
