import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../config/api';
import { galleryService } from '../gallery.service';
vi.mock('../../config/api', () => ({ api: { get: vi.fn() } }));
const get = vi.mocked(api.get);
// Braces matter: a returned mock would be treated as a cleanup hook and called.
beforeEach(() => { get.mockReset(); });
it('joins bounded pages without losing cancellation or unique photo IDs', async () => {
  const signal = new AbortController().signal;
  get.mockResolvedValueOnce({ data: { event: { require_password: 0 }, photos: [{ id: 1 }, { id: 2 }], pagination: { page: 1, has_more: true } } })
    .mockResolvedValueOnce({ data: { photos: [{ id: 2 }, { id: 3 }], pagination: { page: 2, has_more: false } } });
  const result = await galleryService.getGalleryPhotos('wedding', signal);
  expect(result.photos.map(photo => photo.id)).toEqual([1, 2, 3]);
  expect(result.event.require_password).toBe(false);
  expect(get).toHaveBeenNthCalledWith(1, '/gallery/wedding/photos', { params: { limit: 250, page: 1 }, signal });
  expect(get).toHaveBeenNthCalledWith(2, '/gallery/wedding/photos', { params: { limit: 250, page: 2 }, signal });
});
it('keeps four pages in flight and preserves server order when responses finish out of order', async () => {
  const page = (n: number) => ({ data: { event: {}, photos: [{ id: n }], pagination: { page: n, limit: 250, total: 2250, has_more: n < 9 } } });
  const pending = new Map<number, () => void>();
  let active = 0;
  let peak = 0;
  get.mockImplementation((_url, config) => {
    const n = Number((config as { params: { page: number } }).params.page);
    if (n === 1) return Promise.resolve(page(n));
    active++;
    peak = Math.max(peak, active);
    return new Promise<ReturnType<typeof page>>(resolve => {
      pending.set(n, () => {
        pending.delete(n);
        active--;
        resolve(page(n));
      });
    });
  });

  const resultPromise = galleryService.getGalleryPhotos('wedding');
  // No response after page 1 has resolved: serial fetching fails here, and
  // unbounded fetching would request all nine pages instead of just five.
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(5));
  expect([...pending.keys()]).toEqual([2, 3, 4, 5]);
  expect(active).toBe(4);

  // Keep pages 2–4 pending while each released slot starts exactly one page.
  for (const n of [5, 6, 7, 8]) {
    pending.get(n)!();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(n + 1));
    expect(active).toBe(4);
  }
  for (const n of [9, 4, 3, 2]) pending.get(n)!();

  const result = await resultPromise;
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(result.photos.map(photo => photo.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
it('accepts legacy unpaged responses', async () => {
  get.mockResolvedValueOnce({ data: { event: {}, photos: [{ id: 1 }] } });
  expect((await galleryService.getGalleryPhotos('legacy')).photos).toEqual([{ id: 1 }]);
  expect(get).toHaveBeenCalledOnce();
});
it('propagates a cancelled page instead of returning an incomplete gallery', async () => {
  get.mockResolvedValueOnce({ data: { event: {}, photos: [{ id: 1 }], pagination: { page: 1, has_more: true } } })
    .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
  await expect(galleryService.getGalleryPhotos('wedding')).rejects.toMatchObject({ name: 'AbortError' });
});
