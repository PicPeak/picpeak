/**
 * The size picker tells its host when a download was actually handed to the
 * browser. Closing it after a refusal or a failed build must not read as a
 * download, or the grid drops a selection the guest still needs.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
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

const TOKEN = 'b'.repeat(64);
const choices = [{ id: '1500x1000', label: 'Medium', width: 1500, height: 1000 }];

describe('DownloadResolutionModal: onDownloaded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a download handed over, before closing', async () => {
    vi.mocked(galleryService.startDownloadJob).mockResolvedValue({ token: TOKEN, status: 'ready' });
    const calls: string[] = [];
    const user = userEvent.setup();
    render(
      <DownloadResolutionModal
        slug="party"
        choices={choices}
        photoIds={[1, 2]}
        onClose={() => calls.push('close')}
        onDownloaded={() => calls.push('downloaded')}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Prepare download' }));
    await user.click(await screen.findByRole('button', { name: 'Download' }));
    expect(galleryService.downloadJobFile).toHaveBeenCalledWith('party', TOKEN, 'party-1500x1000.zip');
    expect(calls).toEqual(['downloaded', 'close']);
  });

  it('does not report a download when the build fails and the picker is closed', async () => {
    vi.mocked(galleryService.startDownloadJob).mockRejectedValue(new Error('500'));
    const onClose = vi.fn();
    const onDownloaded = vi.fn();
    const user = userEvent.setup();
    render(
      <DownloadResolutionModal slug="party" choices={choices} photoIds={[1, 2]} onClose={onClose} onDownloaded={onDownloaded} />,
    );
    await user.click(screen.getByRole('button', { name: 'Prepare download' }));
    await screen.findByText('Preparation failed');
    // The error panel's own Close (the header has a close icon too).
    const closes = screen.getAllByRole('button', { name: 'Close' });
    await user.click(closes[closes.length - 1]);
    expect(onClose).toHaveBeenCalled();
    expect(onDownloaded).not.toHaveBeenCalled();
  });
});
