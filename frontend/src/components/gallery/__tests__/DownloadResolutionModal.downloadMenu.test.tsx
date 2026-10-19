/**
 * Download menu (issue 1733, E2): every size says in plain words what it is
 * for, the original shows its real file size where the payload has it (and
 * no number where it does not), and the dialog says what the gallery's
 * protection makes of the download.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (k: string, d?: unknown, o?: Record<string, unknown>) => {
      const text = typeof d === 'string' ? d : k;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(o?.[name] ?? ''));
    },
  }),
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
import { DownloadChoiceContext } from '../../../contexts/DownloadChoiceContext';
import { DownloadResolutionModal } from '../DownloadResolutionModal';

const ORIGINAL = { id: 'original', label: 'Original', width: null, height: null };
const LARGE = { id: '3000x2000', label: 'Large', width: 3000, height: 2000 };
const MEDIUM = { id: '1500x1000', label: 'Medium', width: 1500, height: 1000 };
const SMALL = { id: '800x600', label: 'Small', width: 800, height: 600 };

const photo = { id: 1, size: 5 * 1024 * 1024, width: 6000, height: 4000 };

const withWatermark = (ui: React.ReactElement) => (
  <DownloadChoiceContext.Provider value={{ watermarked: true, choose: (_p, start) => start() }}>
    {ui}
  </DownloadChoiceContext.Provider>
);

const option = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) }).closest('label') as HTMLElement;

describe('DownloadResolutionModal: download menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the panel inside the viewport and scrolls it, so the button stays reachable on a short screen', () => {
    render(
      <DownloadResolutionModal slug="party" choices={[ORIGINAL, LARGE, MEDIUM, SMALL]} photo={photo} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog')).toHaveClass('max-h-full', 'overflow-y-auto');
  });

  it('explains each size in plain words, with the photo\'s real original size', () => {
    render(
      <DownloadResolutionModal slug="party" choices={[ORIGINAL, LARGE, MEDIUM, SMALL]} photo={photo} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const original = within(option('Original'));
    expect(original.getByText(/best for printing/)).toBeInTheDocument();
    expect(original.getByText('6000 × 4000 px · 5.0 MB')).toBeInTheDocument();
    expect(within(option('Large')).getByText(/for prints and large screens/)).toBeInTheDocument();
    expect(within(option('Large')).getByText('up to 3000 × 2000 px')).toBeInTheDocument();
    expect(within(option('Medium')).getByText(/Web size — for screens, sharing and social media/)).toBeInTheDocument();
    expect(within(option('Small')).getByText(/quick to send in messages/)).toBeInTheDocument();
    // Nothing about the watermark or a withheld original: neither applies.
    expect(screen.queryByText(/watermark/)).toBeNull();
    expect(screen.queryByText(/not offered/)).toBeNull();
  });

  it('hands the picked size back in menu mode, without building a job', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <DownloadResolutionModal slug="party" choices={[ORIGINAL, MEDIUM]} photo={photo} onPick={onPick} onClose={onClose} />,
    );
    await user.click(screen.getByRole('radio', { name: /^Medium/ }));
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(onPick).toHaveBeenCalledWith('1500x1000');
    expect(onClose).toHaveBeenCalled();
    expect(galleryService.startDownloadJob).not.toHaveBeenCalled();
  });

  it('says every size is watermarked, and drops the file size the watermark changes', () => {
    render(withWatermark(
      <DownloadResolutionModal slug="party" choices={[ORIGINAL, MEDIUM]} photo={photo} onPick={vi.fn()} onClose={vi.fn()} />,
    ));
    expect(screen.getByText(/Every size carries the photographer's watermark, the original too/)).toBeInTheDocument();
    expect(within(option('Original')).getByText('6000 × 4000 px')).toBeInTheDocument();
    expect(screen.queryByText(/MB/)).toBeNull();
  });

  it('says so when the original is not offered', () => {
    render(<DownloadResolutionModal slug="party" choices={[MEDIUM, SMALL]} photoIds={[1]} onClose={vi.fn()} />);
    expect(screen.getByText('The original files are not offered in this gallery. The largest size is up to 1500 × 1000 px.')).toBeInTheDocument();
  });

  it('totals a selection only when every size is known', () => {
    const { unmount } = render(
      <DownloadResolutionModal
        slug="party"
        choices={[ORIGINAL, MEDIUM]}
        photoIds={[1, 2]}
        quotaPhotos={[{ id: 1, size: 1024 * 1024 }, { id: 2, size: 2 * 1024 * 1024 }]}
        onClose={vi.fn()}
      />,
    );
    expect(within(option('Original')).getByText('3.0 MB in total')).toBeInTheDocument();
    unmount();

    render(
      <DownloadResolutionModal
        slug="party"
        choices={[ORIGINAL, MEDIUM]}
        photoIds={[1, 2]}
        quotaPhotos={[{ id: 1, size: 1024 * 1024 }, { id: 2 }]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/in total/)).toBeNull();
  });

  it('gives no total for the whole gallery, whose list may be paged', () => {
    render(
      <DownloadResolutionModal
        slug="party"
        choices={[ORIGINAL, MEDIUM]}
        quotaPhotos={[{ id: 1, size: 1024 * 1024 }]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/in total/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Prepare download' })).toBeInTheDocument();
  });
});
