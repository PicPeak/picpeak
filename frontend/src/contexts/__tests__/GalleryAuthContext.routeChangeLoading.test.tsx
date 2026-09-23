/**
 * GalleryPage holds its public auto-login until this context's `isLoading`
 * settles (fork survey A3 / #1563). Moving from one gallery to another inside
 * the app must not show the new route a settled `false` left over from the
 * previous gallery: until the new gallery's session probe has answered, every
 * render on the new route reads `isLoading: true`.
 */
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

const pendingProbes = new Map<string, (value: unknown) => void>();

vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn((_url: string, options?: { params?: { slug?: string } }) => {
      const slug = options?.params?.slug ?? '';
      return new Promise((resolve) => pendingProbes.set(slug, resolve));
    }),
  },
}));

vi.mock('../../services', () => ({
  authService: {},
  galleryService: {},
}));

vi.mock('../../utils/cleanupGalleryAuth', () => ({ cleanupOldGalleryAuth: vi.fn() }));

import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';

const renders: Array<{ pathname: string; isLoading: boolean }> = [];
let navigateTo: (path: string) => void = () => {};

const Probe: React.FC = () => {
  const { isLoading } = useGalleryAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  navigateTo = navigate;
  renders.push({ pathname, isLoading });
  useEffect(() => {}, [isLoading]);
  return null;
};

afterEach(() => {
  cleanup();
  renders.length = 0;
  pendingProbes.clear();
});

describe('GalleryAuthProvider — loading across a gallery-to-gallery navigation', () => {
  it('never reports a settled session on the new gallery before its probe answers', async () => {
    render(
      <MemoryRouter initialEntries={['/gallery/first-gallery']}>
        <GalleryAuthProvider>
          <Probe />
        </GalleryAuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(pendingProbes.has('first-gallery')).toBe(true));
    await act(async () => {
      pendingProbes.get('first-gallery')!({ data: { valid: false } });
    });
    await waitFor(() => expect(renders.at(-1)).toEqual({ pathname: '/gallery/first-gallery', isLoading: false }));

    await act(async () => {
      navigateTo('/gallery/second-gallery');
    });
    await waitFor(() => expect(pendingProbes.has('second-gallery')).toBe(true));

    const beforeProbe = renders.filter((r) => r.pathname === '/gallery/second-gallery');
    expect(beforeProbe.length).toBeGreaterThan(0);
    expect(beforeProbe.every((r) => r.isLoading)).toBe(true);

    await act(async () => {
      pendingProbes.get('second-gallery')!({ data: { valid: false } });
    });
    await waitFor(() => expect(renders.at(-1)).toEqual({ pathname: '/gallery/second-gallery', isLoading: false }));
  });
});
