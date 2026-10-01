/**
 * A video whose browser-playable copy failed (issue 1430, item 8) says so on
 * its tile; the original still streams, so it is a note next to the video
 * pill, not a failed tile.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' }
    })
  };
});

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />
}));

vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B` }
}));

vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>
}));

const renderWithQueryClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

const basePhoto = {
  path: '/x', url: '/x', thumbnail_url: '/t/x', type: 'individual',
  category_id: null, category_name: null, category_slug: 'individual',
  size: 1234, uploaded_at: '2026-01-01T00:00:00Z', visibility: 'visible', processing_status: 'complete',
};

const photos = [
  { ...basePhoto, id: 1, filename: 'hevc.mov', media_type: 'video', web_status: 'failed', web_error: 'ffmpeg exited with code 1' },
  { ...basePhoto, id: 2, filename: 'fine.mp4', media_type: 'video', web_status: 'complete' },
  { ...basePhoto, id: 3, filename: 'plays.mp4', media_type: 'video', web_status: 'skipped' },
  { ...basePhoto, id: 4, filename: 'old.mp4', media_type: 'video', web_status: null },
] as unknown as AdminPhoto[];

describe('AdminPhotoGrid web copy note', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('notes only the video whose copy failed, with the reason as tooltip', () => {
    renderWithQueryClient(
      <AdminPhotoGrid photos={photos} eventId={42} onPhotoClick={vi.fn()} onPhotosDeleted={vi.fn()} />
    );

    const note = screen.getByTestId('admin-photo-web-copy-failed-1');
    expect(note).toHaveTextContent('No web copy');
    expect(note).toHaveAttribute('title', 'ffmpeg exited with code 1');
    for (const id of [2, 3, 4]) {
      expect(screen.queryByTestId(`admin-photo-web-copy-failed-${id}`)).not.toBeInTheDocument();
    }
    // The tile itself is not a failed tile: the video pill is still there.
    expect(screen.getByTestId('admin-photo-tile-1')).toHaveTextContent('Video');
  });
});
