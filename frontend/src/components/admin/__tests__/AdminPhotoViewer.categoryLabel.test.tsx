/**
 * The viewer's Category line for a row without a real category (issue 1430,
 * item 3): derived like the grid badge, so a video in the default category is
 * not called "Uncategorized" now that the server no longer sends the English
 * "Individual Photos" / "Collages".
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AdminPhotoViewer } from '../AdminPhotoViewer';
import type { AdminPhoto } from '../../../services/photos.service';

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('../AdminAuthenticatedVideo', () => ({ AdminAuthenticatedVideo: () => null }));

vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B`, setPhotoCredit: vi.fn() },
}));

vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return {
    ...actual,
    feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) },
  };
});

const base = {
  path: '/a', url: '/a', thumbnail_url: '/t/a', type: 'individual', category_id: null, category_name: null,
  size: 1, uploaded_at: '2026-01-01T00:00:00Z',
};
const photo = (over: Record<string, unknown>) => ({ ...base, ...over }) as unknown as AdminPhoto;

const renderViewer = (p: AdminPhoto) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AdminPhotoViewer photos={[p]} initialIndex={0} eventId={42} onClose={vi.fn()} onPhotoDeleted={vi.fn()} categories={[]} />
  </QueryClientProvider>
);

describe('AdminPhotoViewer category line', () => {
  it('names the default category by the media on screen', () => {
    renderViewer(photo({ id: 1, filename: 'clip.mov', media_type: 'video', category_slug: 'individual' }));
    expect(screen.getByText('Individual Videos')).toBeInTheDocument();
  });

  it('keeps "Individual Photos" for a photo and a real category by its name', () => {
    const { unmount } = renderViewer(photo({ id: 2, filename: 'a.jpg', media_type: 'image', category_slug: 'individual' }));
    expect(screen.getByText('Individual Photos')).toBeInTheDocument();
    unmount();
    renderViewer(photo({ id: 3, filename: 'b.jpg', category_slug: 'ceremony', category_name: 'Ceremony' }));
    expect(screen.getByText('Ceremony')).toBeInTheDocument();
  });

  it('still says Uncategorized when there is no category at all', () => {
    renderViewer(photo({ id: 4, filename: 'c.jpg', category_slug: null }));
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
  });
});
