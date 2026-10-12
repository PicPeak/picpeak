import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DownloadResolutionModal } from '../DownloadResolutionModal';
import { galleryService } from '../../../services/gallery.service';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (_key: string, fallback?: any, opts?: any) => {
      let text = typeof fallback === 'string' ? fallback : _key;
      for (const [k, v] of Object.entries(opts || {})) text = text.replace(`{{${k}}}`, String(v));
      return text;
    },
  }),
}));
vi.mock('../../../services/gallery.service', () => ({
  galleryService: {
    startDownloadJob: vi.fn(),
    getDownloadJob: vi.fn(),
    downloadJobFile: vi.fn(),
    downloadAllPhotos: vi.fn(),
  },
}));
vi.mock('../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ limited: false, allows: () => true }),
}));
vi.mock('../hooks/useGalleryDialog', () => ({ useGalleryDialog: () => {} }));

const GB = 1024 ** 3;
const choices = [{ id: 'original', label: 'Original', width: null, height: null }];
const service = vi.mocked(galleryService);

const open = (onClose = vi.fn()) => {
  render(<DownloadResolutionModal slug="g" choices={choices} standardResolution="1500x1000" onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare download' }));
  return onClose;
};

describe('DownloadResolutionModal, split downloads (issue 1733)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists every part with its size and says that all are needed', async () => {
    service.startDownloadJob.mockResolvedValue({
      token: 'tok',
      status: 'ready',
      parts: [
        { part: 1, size_bytes: 2 * GB, photo_count: 400 },
        { part: 2, size_bytes: 1.5 * GB, photo_count: 380 },
        { part: 3, size_bytes: 300 * 1024 * 1024, photo_count: 60 },
      ],
    });
    const onClose = open();

    expect(await screen.findByText('This download comes in 3 parts. You need all of them to get every photo.'))
      .toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Part 1 of 3');
    expect(rows[0]).toHaveTextContent('2.0 GB');
    expect(rows[1]).toHaveTextContent('1.5 GB');
    expect(rows[2]).toHaveTextContent('Part 3 of 3');
    expect(rows[2]).toHaveTextContent('300 MB');

    fireEvent.click(screen.getByRole('button', { name: 'Download part 2' }));
    await waitFor(() => expect(service.downloadJobFile)
      .toHaveBeenCalledWith('g', 'tok', 'g-original-part-2-of-3.zip', 2));
    // The other parts are still to be fetched: the dialog stays.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download part 3' })).toBeInTheDocument();
  });

  it('keeps the single button for a download that is one archive', async () => {
    service.startDownloadJob.mockResolvedValue({ token: 'tok', status: 'ready' });
    const onClose = open();

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(service.downloadJobFile).toHaveBeenCalledWith('g', 'tok', 'g-original.zip'));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('picks the parts up from the poll when the build finishes later', async () => {
    service.startDownloadJob.mockResolvedValue({ token: 'tok', status: 'pending' });
    service.getDownloadJob.mockResolvedValue({
      status: 'ready',
      resolution: 'original',
      photo_count: 2,
      size_bytes: 3 * GB,
      parts: [
        { part: 1, size_bytes: 2 * GB, photo_count: 1 },
        { part: 2, size_bytes: GB, photo_count: 1 },
      ],
    });
    open();

    expect(await screen.findByRole('button', { name: 'Download part 2' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
