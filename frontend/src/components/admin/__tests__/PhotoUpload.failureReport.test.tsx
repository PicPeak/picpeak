/**
 * Coverage for the upload failure report — the "which files failed" list.
 *
 * Before this, a partial upload only showed a count ("some files failed"),
 * and the backend's per-file `errors[]` were dropped entirely. These tests
 * pin that every failure stage is named with its reason:
 *   - rejected:   from the upload response's `errors: [{filename, error}]`
 *   - transfer:   from a whole-chunk POST failure (the `catch` path)
 *   - processing: from useUploadProgress's `failedPhotos`
 * plus the settle contract (hasFailures true/false) the modal relies on to
 * decide whether to auto-close, and dismissal.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { PhotoUpload } from '../PhotoUpload';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

// Mutable processing aggregate, swapped per test. Returned only once photos
// are queued (uploadIds non-empty), mirroring the real hook flipping from
// "nothing to track" to "complete" — the transition that fires the settle
// effect.
const clean = () => ({
  total: 0, pending: 0, processing: 0, complete: 0, failed: 0,
  failedPhotos: [] as { id: number; filename: string; error: string | null }[],
  isComplete: false, isReady: true,
});
const hoisted = vi.hoisted(() => ({ aggregate: null as any }));
vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: (ids: string[]) => ({
    snapshots: {},
    error: null,
    aggregate: ids && ids.length > 0
      ? hoisted.aggregate
      : { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, failedPhotos: [], isComplete: false, isReady: true },
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getAllSettings: vi.fn().mockResolvedValue({}) },
}));

const renderWithClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

async function uploadFile(container: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], 'good-photo.png', { type: 'image/png' }));
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
}

describe('PhotoUpload failure report', () => {
  beforeEach(() => {
    postMock.mockReset();
    hoisted.aggregate = clean();
  });
  afterEach(() => vi.clearAllMocks());

  it('names rejected + processing failures and settles with hasFailures', async () => {
    postMock.mockResolvedValue({
      data: { successCount: 1, count: 1, upload_id: 'u1', errors: [{ filename: 'too-big.png', error: 'File too large' }] },
    });
    hoisted.aggregate = {
      total: 2, pending: 0, processing: 0, complete: 1, failed: 1,
      failedPhotos: [{ id: 5, filename: 'corrupt.jpg', error: 'Unsupported format' }],
      isComplete: true, isReady: true,
    };
    const onUploadSettled = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} onUploadSettled={onUploadSettled} />);

    await uploadFile(container, user);

    const report = await screen.findByTestId('upload-failure-report');
    expect(within(report).getByText('too-big.png')).toBeInTheDocument();
    expect(within(report).getByText(/File too large/)).toBeInTheDocument();
    expect(within(report).getByText('Rejected')).toBeInTheDocument();
    expect(within(report).getByText('corrupt.jpg')).toBeInTheDocument();
    expect(within(report).getByText('Processing failed')).toBeInTheDocument();

    // Contract with the modal: the real component fires onUploadSettled and,
    // because something failed, asks the host NOT to auto-close.
    await waitFor(() => expect(onUploadSettled).toHaveBeenCalledWith({ hasFailures: true }));
  });

  it('reports a whole-chunk transfer failure by name', async () => {
    postMock.mockRejectedValue({ response: { data: { error: 'Network error' } } });
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await uploadFile(container, user);

    const report = await screen.findByTestId('upload-failure-report');
    expect(within(report).getByText('good-photo.png')).toBeInTheDocument();
    expect(within(report).getByText(/Network error/)).toBeInTheDocument();
    expect(within(report).getByText('Transfer failed')).toBeInTheDocument();
  });

  it('settles clean when nothing fails, so the modal can auto-close', async () => {
    postMock.mockResolvedValue({ data: { successCount: 1, count: 1, upload_id: 'u1', errors: [] } });
    hoisted.aggregate = {
      total: 1, pending: 0, processing: 0, complete: 1, failed: 0,
      failedPhotos: [], isComplete: true, isReady: true,
    };
    const onUploadSettled = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} onUploadSettled={onUploadSettled} />);

    await uploadFile(container, user);

    await waitFor(() => expect(onUploadSettled).toHaveBeenCalledWith({ hasFailures: false }));
    expect(screen.queryByTestId('upload-failure-report')).not.toBeInTheDocument();
  });

  it('can be dismissed', async () => {
    postMock.mockResolvedValue({
      data: { successCount: 0, count: 0, errors: [{ filename: 'too-big.png', error: 'File too large' }] },
    });
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await uploadFile(container, user);
    const report = await screen.findByTestId('upload-failure-report');

    await user.click(within(report).getByRole('button', { name: /Dismiss/i }));
    expect(screen.queryByTestId('upload-failure-report')).not.toBeInTheDocument();
  });
});
