/**
 * A guest uploading into a gallery that reached its photo limit.
 *
 * The server refuses the file with code PHOTO_CAP_REACHED (a 409, or a 202
 * whose errors[] carries the code when a batch overshoots). The uploader shows
 * one localized message naming the limit and stops sending the remaining
 * files, which could only be refused too.
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

// A plain function rather than vi.fn for the request itself: vitest reports a
// rejection returned by a vi.fn implementation as the test's own failure even
// when the component catches it. Calls are counted by hand.
const postState = vi.hoisted(() => ({ calls: 0, impl: (async () => ({})) as (...a: any[]) => Promise<any> }));
vi.mock('../../../config/api', () => ({
  api: { post: (...a: any[]) => { postState.calls += 1; return postState.impl(...a); } },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: {} }),
}));

async function pickTwoAndUpload(container: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, [
    new File([new Uint8Array([1, 2, 3])], 'first.png', { type: 'image/png' }),
    new File([new Uint8Array([4, 5, 6])], 'second.png', { type: 'image/png' }),
  ]);
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
}

describe('UserPhotoUpload photo limit', () => {
  beforeEach(() => { postState.calls = 0; });
  afterEach(() => vi.clearAllMocks());

  it('shows the photo-limit message once and stops after a 409', async () => {
    postState.impl = () => Promise.reject(Object.assign(new Error('Request failed with status code 409'), {
      response: { status: 409, data: { error: 'limit', code: 'PHOTO_CAP_REACHED', limit: 3 } },
    }));
    const user = userEvent.setup();
    const { container } = render(
      <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} />
    );

    await pickTwoAndUpload(container, user);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('upload.photoCapReached'));
    expect(postState.calls).toBe(1);
    // One message: no generic "files failed" count on top of it.
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('treats a 202 refused for the photo limit the same way', async () => {
    postState.impl = async () => ({
      data: { count: 0, errors: [{ filename: 'first.png', error: 'limit', code: 'PHOTO_CAP_REACHED', limit: 3 }] },
    });
    const user = userEvent.setup();
    const { container } = render(
      <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} />
    );

    await pickTwoAndUpload(container, user);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('upload.photoCapReached'));
    expect(postState.calls).toBe(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
