/**
 * The upload dialog's name step (#1561).
 *
 * - off: no name step, no guest token sent
 * - required: the upload button stays disabled until a name is typed, and the
 *   typed name is registered as the gallery's guest identity BEFORE the first
 *   file goes out, whose request then carries x-guest-token explicitly
 * - a remembered identity is shown instead of the field, "Not you?" drops it
 * - a stored identity the server no longer honours brings the field back
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserPhotoUpload } from '../UserPhotoUpload';
import { getGuestIdentity, storeGuestIdentity, clearGuestIdentity } from '../../../utils/guestIdentityStorage';

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

type Call = { url: string; body: any; config: any };
const postState = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: any; config: any }>,
  upload: (async () => ({ data: { upload_id: 'u1', count: 1 } })) as (...a: any[]) => Promise<any>,
}));
vi.mock('../../../config/api', () => ({
  api: {
    post: (url: string, body: any, config: any) => {
      postState.calls.push({ url, body, config });
      if (url.endsWith('/guest')) {
        return Promise.resolve({
          data: {
            guest: { id: 42, name: body.name, email: null, identifier: 'g-42' },
            token: 'header.eyJ0eXBlIjoiZ3Vlc3QifQ.sig',
          },
        });
      }
      return postState.upload(url, body, config);
    },
  },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: {} }),
}));

const SLUG = 'wedding-anna';
const uploads = (): Call[] => postState.calls.filter((c) => c.url.endsWith('/upload'));

async function pickFile(container: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, [new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })]);
}

describe('UserPhotoUpload uploader name', () => {
  beforeEach(() => {
    postState.calls = [];
    postState.upload = async () => ({ data: { upload_id: 'u1', count: 1 } });
    clearGuestIdentity(SLUG);
  });
  afterEach(() => vi.clearAllMocks());

  it('asks for nothing when the mode is off', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} slug={SLUG} nameMode="off" />
    );
    expect(screen.queryByTestId('uploader-name-step')).toBeNull();
    await pickFile(container, user);
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));
    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(uploads()[0].config.headers['x-guest-token']).toBeUndefined();
  });

  it('requires a name, registers it first, then sends the guest token with the upload', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} slug={SLUG} nameMode="required" />
    );
    await pickFile(container, user);
    const uploadButton = screen.getByRole('button', { name: /common\.upload/ });
    expect(uploadButton).toBeDisabled();

    await user.type(screen.getByLabelText(/upload\.yourName/), 'Anna');
    expect(uploadButton).not.toBeDisabled();
    await user.click(uploadButton);

    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(postState.calls[0].url).toBe(`/gallery/${SLUG}/guest`);
    expect(postState.calls[0].body).toEqual({ name: 'Anna', email: undefined });
    expect(uploads()[0].config.headers['x-guest-token']).toBe('header.eyJ0eXBlIjoiZ3Vlc3QifQ.sig');
    // Remembered on this device for the next batch.
    expect(getGuestIdentity(SLUG)?.name).toBe('Anna');
  });

  it('optional mode uploads without a name and without registering', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} slug={SLUG} nameMode="optional" />
    );
    await pickFile(container, user);
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));
    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(postState.calls.some((c) => c.url.endsWith('/guest'))).toBe(false);
  });

  it('shows a remembered identity, and "Not you?" asks again', async () => {
    storeGuestIdentity(SLUG, { id: 9, name: 'Bea', email: null, identifier: 'g-9' }, 'stored.token.x');
    const user = userEvent.setup();
    render(
      <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} slug={SLUG} nameMode="required" creditsVisible />
    );
    expect(screen.getByText('upload.uploadingAs')).toBeInTheDocument();
    expect(screen.getByText('upload.namePrivacyShown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'upload.notYou' }));
    expect(screen.getByLabelText(/upload\.yourName/)).toBeInTheDocument();
    expect(getGuestIdentity(SLUG)).toBeNull();
  });

  it('brings the name field back when the server no longer knows the stored guest', async () => {
    storeGuestIdentity(SLUG, { id: 9, name: 'Bea', email: null, identifier: 'g-9' }, 'stale.token.x');
    postState.upload = () => Promise.reject(Object.assign(new Error('400'), {
      response: { status: 400, data: { error: 'name', code: 'UPLOADER_NAME_REQUIRED' } },
    }));
    const user = userEvent.setup();
    const { container } = render(
      <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} slug={SLUG} nameMode="required" />
    );
    await pickFile(container, user);
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));
    await waitFor(() => expect(screen.getByLabelText(/upload\.yourName/)).toBeInTheDocument());
    expect(screen.getByText('upload.nameRequired')).toBeInTheDocument();
    // No generic "files failed" toast on top of the inline message.
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
