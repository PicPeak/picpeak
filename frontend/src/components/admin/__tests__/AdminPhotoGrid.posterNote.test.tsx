/**
 * A video that completed on the placeholder tile says so and can be retried
 * (issue 1430, item 6), and the grid's wording follows the media on screen
 * (item 3): the Select control and the default category badge.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      t: (_key: string, fallback?: any, opts?: any) => {
        const o = typeof fallback === 'object' && fallback !== null ? fallback : opts;
        const text = typeof fallback === 'string' ? fallback : _key;
        return o?.count != null ? text.replace('{{count}}', String(o.count)) : text;
      },
      i18n: { language: 'en' }
    })
  };
});

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />
}));

vi.mock('../../../services/photos.service', () => ({
  photosService: {
    formatBytes: (n: number) => `${n} B`
  }
}));

const retryPhoto = vi.fn();
vi.mock('../../../services/uploads.service', () => ({
  uploadsService: { retryPhoto: (...args: unknown[]) => retryPhoto(...args) }
}));

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}));

vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>
}));

const renderWithQueryClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

const basePhoto = {
  path: '/x', url: '/x', thumbnail_url: '/t/x',
  type: 'individual', category_id: null, category_name: null, category_slug: 'individual',
  size: 1234, uploaded_at: '2026-01-01T00:00:00Z', visibility: 'visible', processing_status: 'complete'
};

const photo = (id: number, over: Record<string, unknown>) =>
  ({ ...basePhoto, id, ...over }) as unknown as AdminPhoto;

const renderGrid = (photos: AdminPhoto[]) =>
  renderWithQueryClient(
    <AdminPhotoGrid
      photos={photos}
      eventId={42}
      onPhotoClick={vi.fn()}
      onPhotosDeleted={vi.fn()}
    />
  );

describe('AdminPhotoGrid poster-frame note', () => {
  beforeEach(() => { localStorage.clear(); retryPhoto.mockReset(); retryPhoto.mockResolvedValue({ id: 1, status: 'pending' }); });
  afterEach(() => localStorage.clear());

  it('badges only the complete video whose poster frame failed, with the reason as tooltip', () => {
    renderGrid([
      photo(1, { filename: 'hevc.mov', media_type: 'video', processing_error: 'No poster frame: ffmpeg seek failed' }),
      photo(2, { filename: 'fine.mp4', media_type: 'video', processing_error: null }),
      photo(3, { filename: 'broken.jpg', processing_status: 'failed', processing_error: 'sharp: bad header' }),
    ]);

    const note = screen.getByTestId('admin-photo-poster-note-1');
    expect(note).toHaveTextContent('No poster frame');
    expect(note.firstElementChild).toHaveAttribute('title', 'No poster frame: ffmpeg seek failed');
    expect(screen.queryByTestId('admin-photo-poster-note-2')).not.toBeInTheDocument();
    // A failed row keeps its own placeholder, not this note.
    expect(screen.queryByTestId('admin-photo-poster-note-3')).not.toBeInTheDocument();
  });

  it('shows the note and Retry on the list view too', async () => {
    // The view mode is persisted per admin; a list-view admin would otherwise
    // never see the warning or get the control.
    localStorage.setItem('picpeak.adminPhotos.view', 'list');
    const user = userEvent.setup();
    renderGrid([
      photo(1, { filename: 'clip.mov', media_type: 'video', processing_error: 'No poster frame: ffmpeg seek failed' }),
      photo(2, { filename: 'still.jpg', media_type: 'image' }),
    ]);
    expect(screen.getByTestId('admin-photo-poster-note-1')).toHaveTextContent('No poster frame');
    expect(screen.queryByTestId('admin-photo-poster-note-2')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(retryPhoto).toHaveBeenCalledWith(1));
  });

  it('retries the video from the note', async () => {
    const user = userEvent.setup();
    renderGrid([
      photo(1, { filename: 'hevc.mov', media_type: 'video', processing_error: 'No poster frame: ffmpeg seek failed' }),
    ]);

    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(retryPhoto).toHaveBeenCalledWith(1));
  });
});

describe('AdminPhotoGrid media wording (issue 1430, item 3)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('offers "Select Photos" for a photo-only event and "Select Media" once a video is in the grid', () => {
    const photosOnly = renderGrid([photo(1, { filename: 'a.jpg', media_type: 'image' }), photo(2, { filename: 'b.jpg', media_type: 'image' })]);
    expect(screen.getByRole('button', { name: 'Select Photos' })).toBeInTheDocument();
    photosOnly.unmount();

    renderGrid([photo(1, { filename: 'a.jpg', media_type: 'image' }), photo(2, { filename: 'b.mp4', media_type: 'video' })]);
    expect(screen.getByRole('button', { name: 'Select Media' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select Photos' })).not.toBeInTheDocument();
  });

  it('labels an uncategorised row by its type instead of the server\'s "Individual Photos"', () => {
    renderGrid([
      photo(1, { filename: 'a.jpg', media_type: 'image' }),
      photo(2, { filename: 'b.mp4', media_type: 'video' }),
      photo(3, { filename: 'c.jpg', media_type: 'image', category_name: 'Ceremony', category_slug: 'ceremony' }),
    ]);

    expect(screen.getByTestId('admin-photo-tile-1')).toHaveTextContent('Individual Photos');
    expect(screen.getByTestId('admin-photo-tile-2')).toHaveTextContent('Individual Videos');
    expect(screen.getByTestId('admin-photo-tile-3')).toHaveTextContent('Ceremony');
    expect(screen.getByTestId('admin-photo-tile-3')).not.toHaveTextContent('Individual');
  });
});
