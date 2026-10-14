/**
 * A tab kept "client" in sessionStorage, but the session the server now
 * reports is a guest one (a revoked client token replaced by a live guest
 * cookie). The server's view wins in both directions.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const SLUG = 'summer-party';

vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: { valid: true, type: 'gallery', eventSlug: 'summer-party', accessLevel: 'guest',
      token: 'live-guest-session' } })),
  },
}));

vi.mock('../../services', () => ({
  authService: { verifyGalleryPassword: vi.fn(), shareLinkLogin: vi.fn() },
  galleryService: {
    getGalleryPhotos: vi.fn(async () => ({ event: { id: 7, event_name: 'Summer party', slug: 'summer-party' } })),
    verifyToken: vi.fn(),
  },
}));

vi.mock('../../utils/cleanupGalleryAuth', () => ({ cleanupOldGalleryAuth: vi.fn() }));

import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';

let state: { isAuthenticated: boolean; isLoading: boolean; accessLevel?: string } = { isAuthenticated: false, isLoading: true };

const Probe: React.FC = () => {
  const { isAuthenticated, isLoading, accessLevel } = useGalleryAuth();
  state = { isAuthenticated, isLoading, accessLevel };
  return null;
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('GalleryAuthProvider — access level from the server', () => {
  it('drops a stored client level when the server reports a guest session', async () => {
    sessionStorage.setItem(`gallery_access_level_${SLUG}`, 'client');
    render(
      <MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
        <GalleryAuthProvider>
          <Probe />
        </GalleryAuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(state).toMatchObject({ isAuthenticated: true, isLoading: false }));
    expect(state.accessLevel).toBe('guest');
    expect(sessionStorage.getItem(`gallery_access_level_${SLUG}`)).toBeNull();
  });
});
