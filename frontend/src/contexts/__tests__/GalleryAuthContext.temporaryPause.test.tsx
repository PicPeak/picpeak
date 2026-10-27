import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../config/api', () => ({ api: { get } }));
vi.mock('../../services', () => ({ authService: {}, galleryService: {} }));
vi.mock('../../utils/cleanupGalleryAuth', () => ({ cleanupOldGalleryAuth: vi.fn() }));

import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';
import { storeGalleryToken, getGalleryToken } from '../../utils/galleryAuthStorage';

let auth: ReturnType<typeof useGalleryAuth>;
function Probe() { auth = useGalleryAuth(); return null; }

afterEach(() => { sessionStorage.clear(); localStorage.clear(); get.mockReset(); });

describe('gallery sessions during a temporary pause', () => {
  it.each([['GALLERY_TEMPORARILY_DISABLED', true], ['SESSION_REVOKED', false]])(
    'keeps credentials only for a temporary availability refusal (%s)', async (code, keepToken) => {
      storeGalleryToken('paused', 'existing-session');
      get.mockRejectedValue({ response: { status: 403, data: { code, error: 'Unavailable' } } });
      render(<MemoryRouter initialEntries={['/gallery/paused']}>
        <QueryClientProvider client={new QueryClient()}><GalleryAuthProvider><Probe /></GalleryAuthProvider></QueryClientProvider>
      </MemoryRouter>);
      await waitFor(() => expect(auth.isLoading).toBe(false));
      expect(auth.isAuthenticated).toBe(false);
      expect(getGalleryToken('paused')).toBe(keepToken ? 'existing-session' : null);
    });
});
