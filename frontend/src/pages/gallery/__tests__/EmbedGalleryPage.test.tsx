/**
 * Website embed page (issue 1112): a photo grid with a lightbox on the
 * preview tier and a link out to the full gallery, nothing else; an embed
 * the backend refuses shows a plain "not available".
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const getInfo = vi.fn();
const getPhotos = vi.fn();
vi.mock('../../../services/embed.service', () => ({
  embedService: {
    getInfo: (...args: unknown[]) => getInfo(...args),
    getPhotos: (...args: unknown[]) => getPhotos(...args),
  },
}));

import { EmbedGalleryPage } from '../EmbedGalleryPage';

const TOKEN = 'a'.repeat(64);
const photo = (id: number) => ({
  id, width: 1200, height: 800,
  thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  preview_url: `/api/gallery/demo/preview/${id}`,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/gallery/demo/embed/${TOKEN}`]}>
      <Routes>
        <Route path="/gallery/:slug/embed/:token" element={<EmbedGalleryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EmbedGalleryPage', () => {
  beforeEach(() => {
    getInfo.mockReset();
    getPhotos.mockReset();
    getInfo.mockResolvedValue({ event: { event_name: 'Summer Party' }, gallery_path: '/gallery/demo' });
  });

  it('shows the grid and a link out to the full gallery, without gallery controls', async () => {
    getPhotos.mockResolvedValue({ pagination: { page: 1, limit: 60, total: 2, has_more: false }, photos: [photo(1), photo(2)] });
    renderPage();
    expect(await screen.findByText('Summer Party')).toBeInTheDocument();
    expect(getInfo).toHaveBeenCalledWith('demo', TOKEN);
    expect(getPhotos).toHaveBeenCalledWith('demo', TOKEN, 1);
    expect(screen.getAllByRole('button', { name: /Open photo/ })).toHaveLength(2);
    const link = screen.getByRole('link', { name: /View full gallery/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('href')).toMatch(/\/gallery\/demo$/);
    expect(screen.queryByText(/download/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('opens a photo with its preview, steps through and closes', async () => {
    getPhotos.mockResolvedValue({ pagination: { page: 1, limit: 60, total: 2, has_more: false }, photos: [photo(1), photo(2)] });
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: /Open photo/ }))[0]);
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img')?.getAttribute('src')).toMatch(/\/preview\/1$/);
    fireEvent.click(within(dialog).getByRole('button', { name: /Next photo/ }));
    expect(dialog.querySelector('img')?.getAttribute('src')).toMatch(/\/preview\/2$/);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toMatch(/\/preview\/1$/);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('loads the next page on demand', async () => {
    getPhotos
      .mockResolvedValueOnce({ pagination: { page: 1, limit: 1, total: 2, has_more: true }, photos: [photo(1)] })
      .mockResolvedValueOnce({ pagination: { page: 2, limit: 1, total: 2, has_more: false }, photos: [photo(2)] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Load more/ }));
    // The test i18n does not interpolate, so count the photo buttons.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Open photo/ })).toHaveLength(2));
    expect(getPhotos).toHaveBeenLastCalledWith('demo', TOKEN, 2);
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('says the gallery is not available when the embed is refused', async () => {
    getInfo.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    getPhotos.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    renderPage();
    expect(await screen.findByText('This gallery is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
