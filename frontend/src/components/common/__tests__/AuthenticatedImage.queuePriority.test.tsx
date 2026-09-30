/**
 * Queue priority is read when the request is enqueued, not re-fetched when
 * it changes (#1734).
 *
 * The lightbox keeps a slide's AuthenticatedImage across navigation and flips
 * `queuePriority` between `prefetch` and `high` as the slide moves between
 * neighbour and current. With the prop in the fetch effect's dependencies,
 * that flip aborted the in-flight request (or revoked the loaded blob) and
 * fetched the same image again — the prefetched neighbour was thrown away
 * at the moment it was needed.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/galleryAuthStorage', () => ({
  getActiveGallerySlug: () => 'demo',
  getGalleryToken: () => 'token',
  inferGallerySlugFromLocation: () => 'demo',
  resolveSlugFromRequestUrl: () => 'demo',
}));
vi.mock('../../../utils/url', () => ({ buildResourceUrl: (u: string) => `http://localhost${u}` }));

const slots: Array<{ priority?: string }> = [];
vi.mock('../../../utils/imageFetchQueue', () => ({
  withImageFetchSlot: vi.fn(async (task: () => Promise<unknown>, options: { priority?: string } = {}) => {
    slots.push(options);
    return task();
  }),
}));

import { AuthenticatedImage } from '../AuthenticatedImage';

let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  slots.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(['x'], { type: 'image/png' }),
  })));
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-url-${++n}`) as unknown as typeof URL.createObjectURL;
  revokeObjectURL = vi.fn();
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
});

describe('AuthenticatedImage queuePriority', () => {
  it('enqueues with the priority it was mounted with', async () => {
    render(<AuthenticatedImage src="/api/gallery/demo/photo/1" alt="one" queuePriority="prefetch" />);
    await waitFor(() => expect(slots).toHaveLength(1));
    expect(slots[0].priority).toBe('prefetch');
  });

  it('does not abort or re-fetch a loaded image when the priority changes', async () => {
    const { rerender, findByRole } = render(
      <AuthenticatedImage src="/api/gallery/demo/photo/1" alt="one" queuePriority="prefetch" />,
    );
    await findByRole('img');
    expect(fetch).toHaveBeenCalledTimes(1);

    // The neighbour becomes the current slide.
    rerender(<AuthenticatedImage src="/api/gallery/demo/photo/1" alt="one" queuePriority="high" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(slots).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // A new src still fetches, at the priority current at that moment.
    rerender(<AuthenticatedImage src="/api/gallery/demo/photo/2" alt="two" queuePriority="high" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(slots[1].priority).toBe('high');
  });
});
