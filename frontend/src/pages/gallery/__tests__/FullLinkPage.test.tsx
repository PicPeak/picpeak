/**
 * The full link (issue 2356): /gallery/:slug/full/:token keeps the token for
 * the gallery login, ends a session left from the ordinary link, and opens
 * the gallery.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const galleryLogout = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../services/auth.service', () => ({ authService: { galleryLogout } }));
const clearGalleryToken = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/galleryAuthStorage', () => ({ clearGalleryToken }));

import { FullLinkPage } from '../FullLinkPage';
import { getFullLinkToken } from '../../../utils/galleryFullLink';

const TOKEN = 'c'.repeat(64);

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/gallery/:slug/full/:token" element={<FullLinkPage />} />
        <Route path="/gallery/:slug" element={<p>gallery page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FullLinkPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    galleryLogout.mockClear();
    clearGalleryToken.mockClear();
  });

  it('keeps the token, ends the old session and opens the gallery', async () => {
    sessionStorage.setItem('gallery_event_party', '{}');
    sessionStorage.setItem('gallery_access_level_party', 'client');
    renderAt(`/gallery/party/full/${TOKEN}`);
    expect(await screen.findByText('gallery page')).toBeInTheDocument();
    expect(getFullLinkToken('party')).toBe(TOKEN);
    expect(galleryLogout).toHaveBeenCalledWith('party');
    expect(clearGalleryToken).toHaveBeenCalledWith('party');
    expect(sessionStorage.getItem('gallery_event_party')).toBeNull();
    expect(sessionStorage.getItem('gallery_access_level_party')).toBeNull();
  });

  it('keeps no token that cannot be one', async () => {
    renderAt('/gallery/party/full/not-a-token');
    await waitFor(() => expect(screen.getByText('gallery page')).toBeInTheDocument());
    expect(getFullLinkToken('party')).toBeNull();
  });
});
