/**
 * The full link must still open the gallery when the browser refuses Web
 * Storage (blocked site data, Safari with storage disabled): every call then
 * throws, and a throw inside the hand-over used to leave the visitor on the
 * loading spinner for good.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const galleryLogout = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../services/auth.service', () => ({ authService: { galleryLogout } }));
const sessionGet = vi.hoisted(() => vi.fn());
vi.mock('../../../config/api', () => ({ api: { get: sessionGet } }));

import { FullLinkPage } from '../FullLinkPage';

const TOKEN = 'c'.repeat(64);

describe('FullLinkPage with Web Storage blocked', () => {
  beforeEach(() => {
    sessionGet.mockResolvedValue({ data: { valid: true, type: 'gallery', eventSlug: 'party' } });
    const refuse = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(refuse);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still ends the old session and opens the gallery', async () => {
    render(
      <MemoryRouter initialEntries={[`/gallery/party/full/${TOKEN}`]}>
        <Routes>
          <Route path="/gallery/:slug/full/:token" element={<FullLinkPage />} />
          <Route path="/gallery/:slug" element={<p>gallery page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('gallery page')).toBeInTheDocument();
    expect(galleryLogout).toHaveBeenCalledWith('party');
  });
});
