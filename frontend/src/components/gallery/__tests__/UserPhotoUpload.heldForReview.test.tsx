/**
 * A guest uploading into a gallery that approves guest uploads first
 * (issue 1733).
 *
 * The server stores the photo hidden and answers `held_for_review`. The grid
 * will not change, so the uploader says once that the photos appear after the
 * photographer approved them; a gallery without approval says nothing extra.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const postState = vi.hoisted(() => ({ impl: (async () => ({})) as (...a: any[]) => Promise<any> }));
vi.mock('../../../config/api', () => ({
  api: { post: (...a: any[]) => postState.impl(...a) },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: {} }),
}));

async function uploadTwo(completed = vi.fn()) {
  const user = userEvent.setup();
  const { container } = render(
    <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={completed} onClose={vi.fn()} />
  );
  await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, [
    new File([new Uint8Array([1, 2, 3])], 'first.png', { type: 'image/png' }),
    new File([new Uint8Array([4, 5, 6])], 'second.png', { type: 'image/png' }),
  ]);
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
  await waitFor(() => expect(completed).toHaveBeenCalled());
}

describe('UserPhotoUpload in a gallery that approves guest uploads', () => {
  afterEach(() => vi.clearAllMocks());

  it('says once that the photos appear after approval', async () => {
    let n = 0;
    postState.impl = async () => ({ data: { upload_id: `upload-${n += 1}`, count: 1, held_for_review: true } });
    await uploadTwo();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.info).toHaveBeenCalledTimes(1);
    expect(toastMock.info).toHaveBeenCalledWith('upload.heldForReview', expect.anything());
  });

  it('says nothing extra when uploads are published at once', async () => {
    let n = 0;
    postState.impl = async () => ({ data: { upload_id: `upload-${n += 1}`, count: 1 } });
    await uploadTwo();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.info).not.toHaveBeenCalled();
  });
});
