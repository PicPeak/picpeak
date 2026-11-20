/**
 * Guest identity before downloading (issue 2503).
 *
 * In a gallery that asks for it, any download opens the guest name prompt
 * first; the download starts once the guest has entered a name, never when
 * they close the prompt. A guest already identified downloads without being
 * asked. The prompt says why it opened and shows the photographer's privacy
 * note.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('../../../config/api', () => ({ api: { get: vi.fn(), head: vi.fn(), post: vi.fn(), getUri: vi.fn() } }));
vi.mock('../../../services/guests.service', () => ({
  guestsService: {
    redeemInvite: vi.fn(),
    registerGuest: vi.fn(async (_slug: string, data: { name: string }) => ({
      guest: { id: 7, name: data.name, email: null, identifier: 'id-7' }, token: 'guest-token',
    })),
    getDownloadTicket: vi.fn(async () => 'ticket-1'),
    requestRecoveryCode: vi.fn(async () => undefined),
    verifyRecoveryCode: vi.fn(async () => ({
      guest: { id: 9, name: 'Back', email: 'back@example.com', identifier: 'id-9' }, token: 'recovered-token',
    })),
  },
}));

import { api } from '../../../config/api';
import { guestsService } from '../../../services/guests.service';
import { galleryService } from '../../../services/gallery.service';
import { GuestIdentityProvider } from '../../../contexts/GuestIdentityContext';
import { GuestNamePromptModal } from '../GuestNamePromptModal';
import { GuestRecoveryModal } from '../GuestRecoveryModal';
import { holdGalleryMount, isDownloadIdentityCancelled } from '../../../utils/downloadIdentity';
import { clearGuestIdentity, storeGuestIdentity } from '../../../utils/guestIdentityStorage';

const SLUG = 'wedding';
let outcome: 'pending' | 'done' | 'cancelled' | 'failed';

const DownloadButton: React.FC = () => (
  <button
    type="button"
    onClick={() => {
      outcome = 'pending';
      galleryService.downloadPhoto(SLUG, 3, 'a.jpg')
        .then(() => { outcome = 'done'; })
        .catch((e) => { outcome = isDownloadIdentityCancelled(e) ? 'cancelled' : 'failed'; });
    }}
  >
    Download
  </button>
);

const renderGallery = (requireForDownload: boolean) => render(
  <QueryClientProvider client={new QueryClient()}>
    <GuestIdentityProvider slug={SLUG} identityMode="guest" requireForDownload={requireForDownload}>
      <GuestNamePromptModal privacyText="We only use your name for the album." />
      <GuestRecoveryModal />
      <DownloadButton />
    </GuestIdentityProvider>
  </QueryClientProvider>,
);

const downloadCalls = () => vi.mocked(api.get).mock.calls.filter(([url]) => String(url).includes('/download/'));

beforeEach(() => {
  window.history.replaceState({}, '', `/gallery/${SLUG}`);
  clearGuestIdentity(SLUG);
  vi.mocked(api.get).mockResolvedValue({ data: new Blob(['x'], { type: 'image/jpeg' }), headers: {} });
  vi.spyOn(galleryService, 'triggerBrowserDownload').mockImplementation(() => {});
  outcome = 'pending';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(api.get).mockReset();
  vi.mocked(guestsService.registerGuest).mockClear();
});

describe('guest name before downloading (issue 2503)', () => {
  it('opens the prompt first and downloads once the guest has entered a name', async () => {
    const user = userEvent.setup();
    renderGallery(true);

    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/before downloading/)).toBeInTheDocument();
    expect(screen.getByTestId('guest-prompt-privacy')).toHaveTextContent('We only use your name for the album.');
    expect(downloadCalls()).toHaveLength(0);

    await user.type(screen.getByLabelText(/Your name/), 'Anna');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(outcome).toBe('done'));
    expect(guestsService.registerGuest).toHaveBeenCalledWith(SLUG, { name: 'Anna', email: undefined });
    expect(downloadCalls()).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts no download when the guest closes the prompt', async () => {
    const user = userEvent.setup();
    renderGallery(true);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(outcome).toBe('cancelled'));
    expect(downloadCalls()).toHaveLength(0);
  });

  it('downloads once a returning guest recovered their identity from the prompt', async () => {
    const user = userEvent.setup();
    renderGallery(true);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Get them back' }));
    await user.type(await screen.findByLabelText(/^Email/), 'back@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText(/Verification code/), '123456');
    expect(outcome).toBe('pending');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));

    await waitFor(() => expect(outcome).toBe('done'));
    expect(guestsService.registerGuest).not.toHaveBeenCalled();
    expect(downloadCalls()).toHaveLength(1);
  });

  it('starts no download when the guest leaves recovery without signing in', async () => {
    const user = userEvent.setup();
    renderGallery(true);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Get them back' }));
    await screen.findByLabelText(/^Email/);
    expect(outcome).toBe('pending');
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(outcome).toBe('cancelled'));
    expect(downloadCalls()).toHaveLength(0);
  });

  it('does not ask a guest who is already identified', async () => {
    storeGuestIdentity(SLUG, { id: 7, name: 'Anna', email: null, identifier: 'id-7' }, 'guest-token');
    const user = userEvent.setup();
    renderGallery(true);

    await user.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(outcome).toBe('done'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(downloadCalls()).toHaveLength(1);
  });

  describe('a refused identity replaced mid-download', () => {
    let mounts: number;
    let closeDialog: () => void = () => {};
    const MountCounter: React.FC = () => {
      React.useEffect(() => { mounts += 1; }, []);
      return null;
    };
    // Stands in for the size picker: holds the gallery while it is open.
    const HoldingDialog: React.FC = () => {
      React.useEffect(() => holdGalleryMount(SLUG), []);
      return null;
    };
    const Host: React.FC<{ withDialog: boolean }> = ({ withDialog }) => {
      const [open, setOpen] = React.useState(withDialog);
      closeDialog = () => setOpen(false);
      return (
        <QueryClientProvider client={new QueryClient()}>
          <GuestIdentityProvider slug={SLUG} identityMode="guest" requireForDownload>
            <GuestNamePromptModal />
            <DownloadButton />
            <MountCounter />
            {open && <HoldingDialog />}
          </GuestIdentityProvider>
        </QueryClientProvider>
      );
    };

    let mountsAtRetry: number | null;
    const replaceIdentity = async (withDialog: boolean) => {
      // A guest removed or merged since: the server refuses their identity.
      storeGuestIdentity(SLUG, { id: 5, name: 'Old', email: null, identifier: 'id-5' }, 'stale-token');
      mounts = 0;
      mountsAtRetry = null;
      vi.mocked(api.get)
        .mockRejectedValueOnce(Object.assign(new Error('refused'), {
          response: { status: 403, data: '', headers: { 'x-error-code': 'GUEST_IDENTITY_REQUIRED' } },
        }))
        .mockImplementationOnce(async () => {
          mountsAtRetry = mounts;
          return { data: new Blob(['x'], { type: 'image/jpeg' }), headers: {} };
        });
      const user = userEvent.setup();
      render(<Host withDialog={withDialog} />);
      expect(mounts).toBe(1);

      await user.click(screen.getByRole('button', { name: 'Download' }));
      await screen.findByRole('dialog');
      await user.type(screen.getByLabelText(/Your name/), 'Anna');
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(outcome).toBe('done'));
      expect(downloadCalls()).toHaveLength(2);
      // The retry ran in the same gallery: a dialog driving the download
      // (the size picker) would otherwise have lost its job.
      expect(mountsAtRetry).toBe(1);
    };

    it('rebuilds the gallery for the new guest once the download finished', async () => {
      await replaceIdentity(false);
      // Likes, favourites and labels held in local state are the new guest's.
      await waitFor(() => expect(mounts).toBe(2));
    });

    it('rebuilds the gallery when the guest cancels the replacement prompt', async () => {
      storeGuestIdentity(SLUG, { id: 5, name: 'Old', email: null, identifier: 'id-5' }, 'stale-token');
      mounts = 0;
      vi.mocked(api.get).mockRejectedValueOnce(Object.assign(new Error('refused'), {
        response: { status: 403, data: '', headers: { 'x-error-code': 'GUEST_IDENTITY_REQUIRED' } },
      }));
      const user = userEvent.setup();
      render(<Host withDialog={false} />);

      await user.click(screen.getByRole('button', { name: 'Download' }));
      await screen.findByRole('dialog');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(outcome).toBe('cancelled'));
      // The removed guest's likes and favourites leave the screen all the same.
      await waitFor(() => expect(mounts).toBe(2));
    });

    it('waits with the rebuild until an open download dialog closes', async () => {
      await replaceIdentity(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mounts).toBe(1);
      act(() => closeDialog());
      await waitFor(() => expect(mounts).toBe(2));
    });
  });

  it('does not ask when the gallery does not require it', async () => {
    const user = userEvent.setup();
    renderGallery(false);

    await user.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(outcome).toBe('done'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
