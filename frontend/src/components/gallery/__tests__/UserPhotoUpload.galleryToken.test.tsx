/**
 * The upload URL carries the event id, not the slug, so the api interceptor
 * cannot find this gallery's token and attaches none. The server then falls
 * back to whichever gallery cookie it finds — with a second gallery open in
 * another tab, that gallery's — and refuses the upload with 403. The dialog
 * sends the token of the gallery it uploads to itself.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserPhotoUpload } from '../UserPhotoUpload';
import { setActiveGallerySlug, storeGalleryToken } from '../../../utils/galleryAuthStorage';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any) => (typeof second === 'string' ? second : key),
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const post = vi.hoisted(() => vi.fn(async () => ({ data: { upload_id: 'u1', count: 1 } })));
vi.mock('../../../config/api', () => ({ api: { post } }));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: {} }),
}));

describe('UserPhotoUpload gallery token', () => {
  beforeEach(() => {
    storeGalleryToken('wedding', 'wedding-session');
    storeGalleryToken('party', 'party-session');
    setActiveGallerySlug('party');
  });
  afterEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('sends the token of the gallery being uploaded to', async () => {
    const user = userEvent.setup();
    const completed = vi.fn();
    const { container } = render(
      <UserPhotoUpload eventId={7} slug="wedding" categoryId={null} onUploadComplete={completed} onClose={vi.fn()} />
    );
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, [
      new File([new Uint8Array([1, 2, 3])], 'first.png', { type: 'image/png' }),
    ]);
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));
    await waitFor(() => expect(completed).toHaveBeenCalled());

    expect(post).toHaveBeenCalledTimes(1);
    const config = (post.mock.calls[0] as unknown[])[2] as { headers: Record<string, string> };
    expect(config.headers.Authorization).toBe('Bearer wedding-session');
  });
});
