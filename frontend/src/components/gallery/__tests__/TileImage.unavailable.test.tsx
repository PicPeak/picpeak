/**
 * A thumbnail that will not load (issue 1733, E9).
 *
 * The tile retries twice with the 2 s / 4 s backoff and then shows a neutral
 * "image unavailable" tile in its own box: not the browser's broken-image
 * icon or alt text, not an empty grey square, and not a ThumbHash blur that
 * would read as still loading forever. Pinned against the real
 * AuthenticatedImage, with only fetch stubbed.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../../../utils/galleryAuthStorage', () => ({
  getActiveGallerySlug: () => 'demo',
  getGalleryToken: () => 'token',
  inferGallerySlugFromLocation: () => 'demo',
  resolveSlugFromRequestUrl: () => 'demo',
}));
vi.mock('../../../utils/url', () => ({ buildResourceUrl: (u: string) => `http://localhost${u}` }));
// The real component, without the rest of the barrel (which pulls in the API client).
vi.mock('../../common', async () => ({
  AuthenticatedImage: (await import('../../common/AuthenticatedImage')).AuthenticatedImage,
}));

import { TileImage } from '../TileImage';

const HASH = 'HwgKPZpgh3dwh3eHdXh2eKCACPeH';
const SRC = '/api/gallery/demo/thumbnail/1';

const ok = () => Promise.resolve({
  ok: true,
  blob: async () => new Blob(['x'], { type: 'image/png' }),
});
const status = (code: number) => () => Promise.resolve({
  ok: false,
  status: code,
  statusText: 'x',
  headers: { get: () => null },
});

beforeEach(() => {
  vi.useFakeTimers();
  URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const tile = (props: Partial<React.ComponentProps<typeof TileImage>> = {}) => (
  <div className="relative aspect-square">
    <TileImage src={SRC} alt="IMG_0001.jpg" className="w-full h-full object-cover rounded-lg" thumbHash={HASH} {...props} />
  </div>
);

describe('TileImage unavailable', () => {
  it('retries a 503 twice, then shows the unavailable tile in place of the blur', async () => {
    const fetchMock = vi.fn().mockImplementation(status(503));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(tile());
    await flush();
    expect(screen.queryByTestId('tile-unavailable')).toBeNull();
    expect(screen.getByTestId('tile-placeholder')).toBeInTheDocument();

    await advance(2000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('tile-unavailable')).toBeNull();

    await advance(4000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const unavailable = screen.getByRole('img', { name: 'Image unavailable' });
    expect(unavailable).toHaveAttribute('data-testid', 'tile-unavailable');
    expect(unavailable).toHaveTextContent('Image unavailable');
    // Same box: absolute over the tile, with the image's own rounding.
    expect(unavailable.className).toContain('absolute inset-0');
    expect(unavailable.className).toContain('rounded-lg');
    // No <img> anywhere, so no broken-image icon and no alt text.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByTestId('tile-placeholder')).toBeNull();

    await advance(60_000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up on a 404 at once', async () => {
    const fetchMock = vi.fn().mockImplementation(status(404));
    vi.stubGlobal('fetch', fetchMock);

    render(tile());
    await flush();
    expect(screen.getByTestId('tile-unavailable')).toBeInTheDocument();
    await advance(60_000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the image when a retry recovers', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(status(503)).mockImplementation(ok);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(tile());
    await flush();
    await advance(2000); await flush();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock');
    expect(screen.queryByTestId('tile-unavailable')).toBeNull();
  });

  it('drops the caption on a compact tile and stays decorative with an empty alt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(status(404)));

    render(tile({ compactUnavailable: true, alt: '' }));
    await flush();
    const unavailable = screen.getByTestId('tile-unavailable');
    expect(unavailable).toHaveTextContent('');
    expect(unavailable).toHaveAttribute('aria-hidden', 'true');
    expect(unavailable).not.toHaveAttribute('role');
  });

  // The client's "hidden from guests" dimming is on the image's class; the
  // opaque tile over it would otherwise hide which failed photos are hidden.
  it('keeps the image\'s hidden-from-guests dimming', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(status(404)));

    const dimmed = render(tile({ className: 'w-full h-full object-cover opacity-40' }));
    await flush();
    expect(screen.getByTestId('tile-unavailable').className.split(' ')).toContain('opacity-40');
    dimmed.unmount();

    const important = render(tile({ className: 'w-full h-full object-cover !opacity-40' }));
    await flush();
    expect(screen.getByTestId('tile-unavailable').className.split(' ')).toContain('!opacity-40');
    important.unmount();

    // Only that class: a layout fading its image in (opacity-0) is not copied.
    render(tile({ className: 'w-full h-full object-cover opacity-0' }));
    await flush();
    expect(screen.getByTestId('tile-unavailable').className).not.toMatch(/opacity-0/);
  });
});
