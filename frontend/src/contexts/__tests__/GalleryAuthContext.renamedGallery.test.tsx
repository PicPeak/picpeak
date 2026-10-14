/**
 * A visitor logged in before a gallery rename opens an old-slug link. The old
 * slug's session still verifies, but its gallery no longer answers at that
 * slug; the page then moves to the new slug, where the server carries the
 * session over (same claims, eventSlug = new slug) and hands the token back.
 * The context must end up authenticated there without a login call, and
 * replace a stale token kept for the new slug (sent as a Bearer, it would win
 * over the cookie).
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

const { OLD_SLUG, NEW_SLUG } = vi.hoisted(() => ({ OLD_SLUG: 'summer-party', NEW_SLUG: 'summer-party-2026' }));

const sessionCalls: string[] = vi.hoisted(() => [] as string[]);
vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn(async (_url: string, options?: { params?: { slug?: string } }) => {
      const slug = options?.params?.slug ?? '';
      sessionCalls.push(slug);
      return { data: { valid: true, type: 'gallery', eventSlug: slug, accessLevel: 'guest',
        ...(slug === NEW_SLUG && { token: 'renewed-session' }) } };
    }),
  },
}));

const { login, shareLinkLogin } = vi.hoisted(() => ({ login: vi.fn(), shareLinkLogin: vi.fn() }));
vi.mock('../../services', () => ({
  authService: { verifyGalleryPassword: login, shareLinkLogin },
  galleryService: {
    getGalleryPhotos: vi.fn(async (slug: string) => {
      if (slug === OLD_SLUG) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      return { event: { id: 7, event_name: 'Summer party', slug: NEW_SLUG } };
    }),
    verifyToken: vi.fn(),
  },
}));

vi.mock('../../utils/cleanupGalleryAuth', () => ({ cleanupOldGalleryAuth: vi.fn() }));

import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';
import { getGalleryToken, storeGalleryToken } from '../../utils/galleryAuthStorage';

let state: { isAuthenticated: boolean; isLoading: boolean } = { isAuthenticated: false, isLoading: true };
let navigateTo: (path: string) => void = () => {};

const Probe: React.FC = () => {
  const { isAuthenticated, isLoading } = useGalleryAuth();
  navigateTo = useNavigate();
  state = { isAuthenticated, isLoading };
  return null;
};

afterEach(() => {
  cleanup();
  sessionCalls.length = 0;
  sessionStorage.clear();
});

describe('GalleryAuthProvider — session after a gallery rename', () => {
  it('is authenticated at the new slug without logging in again', async () => {
    // Left over from an earlier visit; as a Bearer it would win over the cookie.
    storeGalleryToken(NEW_SLUG, 'stale-session');
    render(
      <MemoryRouter initialEntries={[`/gallery/${OLD_SLUG}`]}>
        <GalleryAuthProvider>
          <Probe />
        </GalleryAuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(state).toEqual({ isAuthenticated: false, isLoading: false }));

    await act(async () => {
      navigateTo(`/gallery/${NEW_SLUG}`);
    });
    await waitFor(() => expect(state).toEqual({ isAuthenticated: true, isLoading: false }));
    expect(sessionCalls).toEqual([OLD_SLUG, NEW_SLUG]);
    expect(login).not.toHaveBeenCalled();
    expect(shareLinkLogin).not.toHaveBeenCalled();
    expect(getGalleryToken(NEW_SLUG)).toBe('renewed-session');
  });
});
