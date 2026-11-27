/**
 * The picker's gallery list (issue 2618): a gallery with a password can be
 * put on the website, and the picker says what that publishes. The list is
 * paged and searchable, so older galleries stay reachable.
 */
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WebsiteGallery } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: undefined }) }));
vi.mock('../../../utils/url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/url')>()),
  buildResourceUrl: (path: string) => `https://api.example.com${path}`,
}));
vi.mock('../../../services/website.service', () => ({
  websiteService: { listGalleries: vi.fn(), setGalleryOnWebsite: vi.fn(), listAssets: vi.fn(), listGalleryPhotos: vi.fn() },
  mediaKey: (r: { source: string; id: string | number }) => `${r.source}:${r.id}`,
}));

import { websiteService } from '../../../services/website.service';
import { GalleriesPane, GalleryPhotosPane, UploadsPane } from '../ImagePicker';

const gallery = (id: number, name: string, extra: Partial<WebsiteGallery> = {}): WebsiteGallery => ({
  id, name, slug: `g${id}`, date: null, showOnWebsite: true, eligible: true, hasPassword: false, reason: null, canChange: true, ...extra,
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('GalleriesPane', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a protected gallery be picked from and says what becomes public', async () => {
    vi.mocked(websiteService.listGalleries).mockResolvedValue({
      galleries: [gallery(1, 'Private wedding', { hasPassword: true }), gallery(2, 'Open portraits')], hasMore: false,
    });
    wrap(<GalleriesPane onOpen={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Private wedding' })).toBeInTheDocument();
    expect(screen.getAllByText('Has a password. On the website, the photos you pick are public; the rest of the gallery keeps its password.')).toHaveLength(1);
    expect(screen.getByText(/makes the photos you pick public, even when the gallery has a password/)).toBeInTheDocument();
  });

  it('a visibility change refreshes the preview and the picked images, not only the list', async () => {
    vi.mocked(websiteService.listGalleries).mockResolvedValue({ galleries: [gallery(1, 'Open portraits')], hasMore: false });
    vi.mocked(websiteService.setGalleryOnWebsite).mockResolvedValue(undefined as never);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(<QueryClientProvider client={client}><GalleriesPane onOpen={() => {}} /></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Open portraits' });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(websiteService.setGalleryOnWebsite).toHaveBeenCalledWith(1, false));
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey?.[0]);
      expect(keys).toEqual(expect.arrayContaining(['website-galleries', 'website-media', 'website-preview']));
    });
  });

  it('loads more galleries and searches by name', async () => {
    vi.mocked(websiteService.listGalleries).mockImplementation(async ({ page = 1, q = '' } = {}) => {
      if (q) return { galleries: [gallery(9, 'Old summer')], hasMore: false };
      return page === 1 ? { galleries: [gallery(1, 'Newest')], hasMore: true } : { galleries: [gallery(2, 'Older')], hasMore: false };
    });
    wrap(<GalleriesPane onOpen={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Newest' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: 'Older' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'summer' } });
    expect(await screen.findByRole('button', { name: 'Old summer' })).toBeInTheDocument();
    await waitFor(() => expect(websiteService.listGalleries).toHaveBeenCalledWith(expect.objectContaining({ q: 'summer', page: 1 })));
  });
});

describe('GalleriesPane west of UTC', () => {
  let previousTz: string | undefined;
  beforeAll(() => { previousTz = process.env.TZ; process.env.TZ = 'America/Los_Angeles'; });
  afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

  it('shows a gallery date as the calendar day it is, not the evening before', async () => {
    vi.mocked(websiteService.listGalleries).mockResolvedValue({ galleries: [gallery(1, 'Summer wedding', { date: '2026-06-01' })], hasMore: false });
    wrap(<GalleriesPane onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Summer wedding' });
    expect(screen.getByText(/June 1st, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/5\/31\/2026|May 31/)).toBeNull();
  });
});

describe('GalleryPhotosPane', () => {
  it('says the photos keep the gallery watermark, and where clean images come from', async () => {
    vi.mocked(websiteService.listGalleryPhotos).mockResolvedValue({ photos: [], hasMore: false });
    wrap(<GalleryPhotosPane gallery={gallery(1, 'Open portraits')} onBack={() => {}} isSelected={() => false} onToggle={() => {}} />);
    expect(await screen.findByText('Photos from this gallery appear with its watermark; upload images directly for a clean portfolio.')).toBeInTheDocument();
  });
});

describe('UploadsPane', () => {
  it('loads more uploads and searches by file name', async () => {
    const asset = (id: string, name: string) => ({ id, kind: 'image' as const, width: 1, height: 1, originalFilename: name, sizeBytes: 1, createdAt: '', previewUrl: `/m/${id}`, videoUrl: null });
    vi.mocked(websiteService.listAssets).mockImplementation(async ({ page = 1, q = '' } = {}) => {
      if (q) return { assets: [asset('c', 'beach.jpg')], hasMore: false };
      return page === 1 ? { assets: [asset('a', 'one.jpg')], hasMore: true } : { assets: [asset('b', 'two.jpg')], hasMore: false };
    });
    wrap(<UploadsPane kind="image" isSelected={() => false} onToggle={() => {}} />);
    expect(await screen.findByRole('button', { name: 'one.jpg' })).toBeInTheDocument();
    // Thumbnails come from the backend's origin in a split-origin install.
    expect(screen.getByRole('button', { name: 'one.jpg' }).querySelector('img')?.getAttribute('src')).toBe('https://api.example.com/m/a');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: 'two.jpg' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'beach' } });
    expect(await screen.findByRole('button', { name: 'beach.jpg' })).toBeInTheDocument();
    expect(websiteService.listAssets).toHaveBeenCalledWith(expect.objectContaining({ q: 'beach', kind: 'image' }));
  });
});
