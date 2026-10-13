/**
 * "Email me when it is ready" and the link in that mail (issue 1733).
 *
 * The option appears only when the server says it holds an address for this
 * visitor, and the request carries no address. A job opened from the mail
 * link starts at that job instead of at the size picker.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('../../../services/gallery.service', () => ({
  galleryService: {
    startDownloadJob: vi.fn(),
    getDownloadJob: vi.fn(),
    requestDownloadJobMail: vi.fn(),
    downloadJobFile: vi.fn(),
    downloadAllPhotos: vi.fn(),
  },
}));
vi.mock('../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ limited: false, allows: () => true }),
}));
vi.mock('../hooks/useGalleryDialog', () => ({ useGalleryDialog: vi.fn() }));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));

import { galleryService } from '../../../services/gallery.service';
import { DownloadResolutionModal } from '../DownloadResolutionModal';
import { clearDownloadJobParam, readDownloadJobParam } from '../downloadJobLink';

const TOKEN = 'a'.repeat(64);
const choices = [{ id: '1500x1000', label: 'Medium', width: 1500, height: 1000 }];
const job = (over: Record<string, unknown> = {}) => ({
  status: 'building', resolution: '1500x1000', photo_count: 0, size_bytes: null, ...over,
});

describe('DownloadResolutionModal: email me when it is ready', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(galleryService.startDownloadJob).mockResolvedValue({ token: TOKEN, status: 'pending' });
    vi.mocked(galleryService.requestDownloadJobMail).mockResolvedValue(undefined);
  });

  const prepare = async () => {
    const user = userEvent.setup();
    render(<DownloadResolutionModal slug="party" choices={choices} photoIds={[1]} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Prepare download' }));
    return user;
  };

  it('offers the mail when the server holds an address, and sends no address', async () => {
    vi.mocked(galleryService.getDownloadJob).mockResolvedValue(job({ notify: 'available' }) as never);
    const user = await prepare();
    await user.click(await screen.findByRole('button', { name: 'Email me when it is ready' }, { timeout: 4000 }));

    expect(galleryService.requestDownloadJobMail).toHaveBeenCalledWith('party', TOKEN);
    expect(await screen.findByRole('status')).toHaveTextContent('We will email you');
    expect(screen.queryByRole('button', { name: 'Email me when it is ready' })).not.toBeInTheDocument();
  });

  it('does not offer the mail to a visitor without a stored address', async () => {
    vi.mocked(galleryService.getDownloadJob).mockResolvedValue(job() as never);
    await prepare();
    await waitFor(() => expect(galleryService.getDownloadJob).toHaveBeenCalled(), { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Email me when it is ready' })).not.toBeInTheDocument();
  });

  it('offers the mail again for a new attempt after a failed mail request', async () => {
    vi.mocked(galleryService.requestDownloadJobMail).mockRejectedValueOnce(new Error('500'));
    vi.mocked(galleryService.getDownloadJob)
      .mockResolvedValueOnce(job({ notify: 'available' }) as never)
      .mockResolvedValueOnce(job({ status: 'failed', error: 'boom' }) as never)
      .mockResolvedValue(job({ notify: 'available' }) as never);
    const user = await prepare();
    await user.click(await screen.findByRole('button', { name: 'Email me when it is ready' }, { timeout: 4000 }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be set up');

    await user.click(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 }));
    await user.click(screen.getByRole('button', { name: 'Prepare download' }));
    expect(await screen.findByRole('button', { name: 'Email me when it is ready' }, { timeout: 4000 })).toBeInTheDocument();
  }, 15000);

  it('opens a job from the mail link ready to download', async () => {
    vi.mocked(galleryService.getDownloadJob).mockResolvedValue(job({ status: 'ready', resolution: '800x600' }) as never);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DownloadResolutionModal slug="party" choices={choices} resumeToken={TOKEN} onClose={onClose} />);

    await user.click(await screen.findByRole('button', { name: 'Download' }));
    expect(galleryService.downloadJobFile).toHaveBeenCalledWith('party', TOKEN, 'party-800x600.zip');
    expect(galleryService.startDownloadJob).not.toHaveBeenCalled();
  });

  it('says so when the job from the mail link is gone', async () => {
    vi.mocked(galleryService.getDownloadJob).mockRejectedValue(new Error('404'));
    render(<DownloadResolutionModal slug="party" choices={choices} resumeToken={TOKEN} onClose={vi.fn()} />);
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    // Nothing to prepare again from here: the selection is not known.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('does not offer a job the server would no longer hand over', async () => {
    vi.mocked(galleryService.getDownloadJob).mockResolvedValue(job({ status: 'ready', unavailable: true }) as never);
    render(<DownloadResolutionModal slug="party" choices={choices} resumeToken={TOKEN} onClose={vi.fn()} />);
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });
});

describe('download job link', () => {
  it('reads a token and nothing else', () => {
    expect(readDownloadJobParam(`?download_job=${TOKEN}`)).toBe(TOKEN);
    expect(readDownloadJobParam('?download_job=../../etc')).toBeNull();
    expect(readDownloadJobParam('?photo=3')).toBeNull();
  });

  it('reading leaves the address bar alone, so a second mount still finds the token', () => {
    window.history.replaceState({ kept: true }, '', `/gallery/party?folder=a&download_job=${TOKEN}`);
    expect(readDownloadJobParam()).toBe(TOKEN);
    expect(readDownloadJobParam()).toBe(TOKEN);
  });

  it('closing drops the token from the address bar and keeps the rest', () => {
    window.history.replaceState({ kept: true }, '', `/gallery/party?folder=a&download_job=${TOKEN}`);
    clearDownloadJobParam();
    expect(window.location.search).toBe('?folder=a');
    expect(window.history.state).toEqual({ kept: true });
    expect(readDownloadJobParam()).toBeNull();
  });
});
