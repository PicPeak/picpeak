/**
 * The viewer's credit edit shows the server's reason when a name is refused
 * (issue 1561 review): "<>" has nothing left once sanitised, and the 400 says
 * so — a bare "error" left the admin guessing.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AdminPhotoViewer } from '../AdminPhotoViewer';
import type { AdminPhoto } from '../../../services/photos.service';

const { setPhotoCredit, toastError } = vi.hoisted(() => ({
  setPhotoCredit: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-toastify', () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('../AdminAuthenticatedVideo', () => ({ AdminAuthenticatedVideo: () => null }));

vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B`, setPhotoCredit },
}));

vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return {
    ...actual,
    feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) },
  };
});

const photo = {
  id: 7, filename: 'a.jpg', path: '/a.jpg', url: '/a.jpg', thumbnail_url: '/t/a.jpg',
  type: 'photo', category_id: null, category_slug: null, size: 1, uploaded_at: '2026-01-01T00:00:00Z',
  credit_name: 'Anna',
} as unknown as AdminPhoto;

const renderViewer = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AdminPhotoViewer photos={[photo]} initialIndex={0} eventId={42} onClose={vi.fn()} onPhotoDeleted={vi.fn()} categories={[]} />
  </QueryClientProvider>
);

async function submitName(name: string) {
  const user = userEvent.setup();
  renderViewer();
  await user.click(screen.getByText('admin.photos.credit.edit'));
  const input = screen.getByLabelText('admin.photos.credit.label');
  await user.clear(input);
  await user.type(input, name);
  await user.click(screen.getByText('admin.photos.credit.save'));
}

describe('AdminPhotoViewer credit error', () => {
  beforeEach(() => {
    setPhotoCredit.mockReset();
    toastError.mockReset();
  });

  it('shows the server reason for a refused name', async () => {
    setPhotoCredit.mockRejectedValue({ response: { data: { error: 'This name has no characters that can be shown.' } } });
    await submitName('<>');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('This name has no characters that can be shown.'));
  });

  it('falls back to the generic message', async () => {
    setPhotoCredit.mockRejectedValue(new Error('Network Error'));
    await submitName('Anna B');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('common.error'));
  });
});
