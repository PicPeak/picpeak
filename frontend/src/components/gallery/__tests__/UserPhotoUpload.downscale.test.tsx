/**
 * The upload dialog sends what prepareGuestUpload hands back (issue 1733): the
 * scaled file under the gallery's longest edge, with the capture date read
 * from the original as a form field.
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

vi.mock('react-toastify', () => ({ toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const posted = vi.hoisted(() => [] as FormData[]);
vi.mock('../../../config/api', () => ({
  api: { post: async (_url: string, body: FormData) => { posted.push(body); return { data: { count: 1, upload_id: 'abcdef123456' } }; } },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: {} }),
}));

const prepareMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/guestUploadDownscale', () => ({ prepareGuestUpload: prepareMock }));

describe('UserPhotoUpload downscale', () => {
  afterEach(() => { vi.clearAllMocks(); posted.length = 0; });

  it('prepares each file under the gallery edge and sends the result', async () => {
    const scaled = new File([new Uint8Array([9])], 'first.jpg', { type: 'image/jpeg' });
    prepareMock
      .mockResolvedValueOnce({ file: scaled, capturedAt: '2024:05:01 09:10:11' })
      .mockImplementationOnce(async (file: File) => ({ file, capturedAt: null }));
    const first = new File([new Uint8Array([1, 2, 3])], 'first.jpg', { type: 'image/jpeg' });
    const second = new File([new Uint8Array([4, 5, 6])], 'second.png', { type: 'image/png' });

    const user = userEvent.setup();
    const completed = vi.fn();
    const { container } = render(
      <UserPhotoUpload eventId={7} categoryId={null} maxEdge={2048} onUploadComplete={completed} onClose={vi.fn()} />
    );
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, [first, second]);
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));

    await waitFor(() => expect(completed).toHaveBeenCalled());
    expect(prepareMock).toHaveBeenNthCalledWith(1, first, 2048);
    expect(prepareMock).toHaveBeenNthCalledWith(2, second, 2048);
    expect(posted).toHaveLength(2);
    expect(posted[0].get('photos')).toBe(scaled);
    expect(posted[0].get('captured_at')).toBe('2024:05:01 09:10:11');
    expect(posted[1].get('photos')).toBe(second);
    expect(posted[1].has('captured_at')).toBe(false);
  });
});
