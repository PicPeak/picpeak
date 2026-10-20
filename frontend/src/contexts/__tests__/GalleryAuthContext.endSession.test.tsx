/**
 * Issue 2209: the guest identity outlives the gallery session by design
 * (30 days in localStorage against a 24h session token). A session the server
 * rejected used to go through logout(), which also dropped the identity, so a
 * guest coming back later was unidentified with their single-use invite
 * already spent. endSession() closes the session and keeps the identity; only
 * the visitor's own logout() drops it.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const SLUG = 'wedding';

vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn(async () => ({ data: { valid: true, type: 'gallery', eventSlug: SLUG, accessLevel: 'guest' } })),
  },
}));

const { galleryLogout } = vi.hoisted(() => ({ galleryLogout: vi.fn() }));
vi.mock('../../services', () => ({
  authService: { verifyGalleryPassword: vi.fn(), shareLinkLogin: vi.fn(), galleryLogout },
  galleryService: {
    getGalleryPhotos: vi.fn(async () => ({ event: { id: 7, event_name: 'Wedding', slug: SLUG } })),
    verifyToken: vi.fn(),
  },
}));

vi.mock('../../utils/cleanupGalleryAuth', () => ({ cleanupOldGalleryAuth: vi.fn() }));

import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';
import { storeGalleryToken } from '../../utils/galleryAuthStorage';
import { getGuestIdentity, storeGuestIdentity } from '../../utils/guestIdentityStorage';

// Unsigned, but the client only reads `exp` to drop expired identities.
const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
const guestToken = `${b64({ alg: 'none' })}.${b64({ type: 'guest', exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;

let auth: ReturnType<typeof useGalleryAuth> | null = null;
const Probe: React.FC = () => { auth = useGalleryAuth(); return null; };

const mountAuthenticated = async () => {
  storeGalleryToken(SLUG, 'gallery-session');
  storeGuestIdentity(SLUG, { id: 5, name: 'Invited' } as never, guestToken);
  render(
    <MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
      <GalleryAuthProvider><Probe /></GalleryAuthProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(auth?.isAuthenticated).toBe(true));
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  galleryLogout.mockClear();
});

describe('GalleryAuthProvider: ending a rejected session keeps the guest', () => {
  it('endSession() signs the session out and keeps the guest identity', async () => {
    await mountAuthenticated();
    act(() => auth!.endSession());
    await waitFor(() => expect(auth?.isAuthenticated).toBe(false));
    expect(galleryLogout).toHaveBeenCalledWith(SLUG);
    expect(getGuestIdentity(SLUG)).toEqual({ id: 5, name: 'Invited' });
  });

  it('logout() still drops the guest identity, for a shared device', async () => {
    await mountAuthenticated();
    act(() => auth!.logout());
    await waitFor(() => expect(auth?.isAuthenticated).toBe(false));
    expect(getGuestIdentity(SLUG)).toBeNull();
  });
});
