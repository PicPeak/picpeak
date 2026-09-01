/**
 * A guest must not be told their photo uploaded when it was refused.
 *
 * `POST /gallery/:id/upload` answers 202 even when the queue rejects the file
 * (content/type mismatch, photo cap) — the refusal comes back as `count: 0`
 * plus an `errors[]` entry. The uploader treated "the request resolved" as
 * success, so the guest got "Upload completed successfully (1 photos)" for a
 * photo that never existed: the guest-side twin of QA P4-B.05 / 7.05.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserPhotoUpload } from '../UserPhotoUpload';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any) => (typeof second === 'string' ? second : key),
    }),
  };
});

const toastMock = vi.hoisted(() => ({
  warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: toastMock }));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a) } }));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: {} }),
}));

const renderUploader = (onUploadComplete = vi.fn()) => {
  const utils = render(
    <UserPhotoUpload
      eventId={7}
      categoryId={null}
      onUploadComplete={onUploadComplete}
      onClose={vi.fn()}
    />
  );
  return { ...utils, onUploadComplete };
};

async function pickAndUpload(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, name: string) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }));
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
}

describe('UserPhotoUpload rejected file', () => {
  beforeEach(() => postMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  it('does not report success for a 202 that queued nothing', async () => {
    postMock.mockResolvedValue({
      data: {
        upload_id: 'u1',
        count: 0,
        errors: [{ filename: 'fake.png', error: 'File content does not match declared type' }],
      },
    });
    const user = userEvent.setup();
    const { container, onUploadComplete } = renderUploader();

    await pickAndUpload(container, user, 'fake.png');

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'fake.png: File content does not match declared type'
      )
    );
    expect(toastMock.success).not.toHaveBeenCalled();
    // Nothing was queued, so there is no upload group worth polling.
    expect(onUploadComplete).not.toHaveBeenCalled();
  });

  it('still reports success and hands over the upload id when the file lands', async () => {
    postMock.mockResolvedValue({ data: { upload_id: 'u1', count: 1 } });
    const user = userEvent.setup();
    const { container, onUploadComplete } = renderUploader();

    await pickAndUpload(container, user, 'good.png');

    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(onUploadComplete).toHaveBeenCalledWith(['u1']);
  });
});
