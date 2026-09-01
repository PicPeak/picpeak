/**
 * The completion toast must describe what actually happened.
 *
 * QA P4-B.05 / 7.05: uploading past a photo cap (whole request 400s) and
 * uploading a `.txt` renamed to `.jpg` (magic-byte rejection) both produced a
 * generic "Upload completed successfully" toast *alongside* the rejection
 * toast, with 0 of N files in the gallery. The success toast came from the
 * host's `onUploadComplete` handler, which PhotoUpload fires purely as a
 * "refresh the grid" signal — including on runs where nothing landed.
 *
 * These pin the outcome contract:
 *   - nothing landed  -> no success toast (and the refresh still fires)
 *   - some landed     -> an accurate partial message, not "complete!"
 *   - all landed      -> success
 * plus the host-side rule that the refresh callback never announces success.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'fs';
import path from 'path';
import type { ReactElement } from 'react';

import { PhotoUpload } from '../PhotoUpload';

// Interpolating t() — the partial message is only meaningful with its numbers
// substituted, so the mock has to do what i18next would.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any, third?: any) => {
        const fallback = typeof second === 'string' ? second : undefined;
        const vars = (typeof second === 'object' ? second : third) || {};
        let out = fallback ?? key;
        for (const [k, v] of Object.entries(vars)) {
          out = out.split(`{{${k}}}`).join(String(v));
        }
        return out;
      },
    }),
  };
});

const toastMock = vi.hoisted(() => ({
  warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: toastMock }));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

const hoisted = vi.hoisted(() => ({ aggregate: null as any }));
const idle = {
  total: 0, pending: 0, processing: 0, complete: 0, failed: 0,
  failedPhotos: [] as { id: number; filename: string; error: string | null }[],
  isComplete: false, isReady: true,
};
vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: (ids: string[]) => ({
    snapshots: {},
    error: null,
    aggregate: ids && ids.length > 0 ? hoisted.aggregate : idle,
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

const makeFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

async function uploadFiles(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, names: string[]) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, names.map(makeFile));
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
}

describe('PhotoUpload completion toast', () => {
  beforeEach(() => {
    postMock.mockReset();
    hoisted.aggregate = { ...idle };
  });
  afterEach(() => vi.clearAllMocks());

  it('stays silent on success when the whole request was refused (photo cap)', async () => {
    // Backend 400s the entire upload — every file is a transfer failure.
    postMock.mockRejectedValue({
      response: { data: { error: 'Photo cap exceeded. This event allows a maximum of 3 photos.' } },
    });
    const onUploadComplete = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithClient(
      <PhotoUpload eventId={1} onUploadComplete={onUploadComplete} />
    );

    await uploadFiles(container, user, ['a.png', 'b.png']);

    await screen.findByTestId('upload-failure-report');
    expect(toastMock.success).not.toHaveBeenCalled();
    // The grid refresh still has to happen — it is a refresh signal, which is
    // exactly why the host must not hang a success toast off it.
    expect(onUploadComplete).toHaveBeenCalled();
  });

  it('stays silent on success when every file was rejected per-file', async () => {
    // 202, but count 0: nothing was queued (renamed .txt / magic-byte check).
    postMock.mockResolvedValue({
      data: {
        count: 0,
        upload_id: 'u1',
        errors: [{ filename: 'fake.jpg', error: 'File content does not match declared type' }],
      },
    });
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await uploadFiles(container, user, ['fake.jpg']);

    await screen.findByTestId('upload-failure-report');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('reports the real split when some files land and others do not', async () => {
    postMock.mockResolvedValue({
      data: {
        count: 1,
        upload_id: 'u1',
        errors: [{ filename: 'fake.jpg', error: 'File content does not match declared type' }],
      },
    });
    hoisted.aggregate = {
      total: 1, pending: 0, processing: 0, complete: 1, failed: 0,
      failedPhotos: [], isComplete: true, isReady: true,
    };
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await uploadFiles(container, user, ['good.png', 'fake.jpg']);

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        '1 of 2 files uploaded — 1 could not be uploaded.'
      )
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('still congratulates a clean upload', async () => {
    postMock.mockResolvedValue({ data: { count: 1, upload_id: 'u1', errors: [] } });
    hoisted.aggregate = {
      total: 1, pending: 0, processing: 0, complete: 1, failed: 0,
      failedPhotos: [], isComplete: true, isReady: true,
    };
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await uploadFiles(container, user, ['good.png']);

    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(toastMock.warning).not.toHaveBeenCalled();
  });
});

describe('host refresh callback', () => {
  it('does not announce success from the Photos tab refresh handler', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'pages', 'admin', 'event-details', 'PhotosTab.tsx'),
      'utf8'
    );
    const handler = source.slice(
      source.indexOf('onUploadComplete={'),
      source.indexOf('{/* Photo Filters */}')
    );
    expect(handler).toContain('refetchPhotos()');
    expect(handler).not.toContain('toast.success');
  });
});
