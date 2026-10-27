import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { ArchiveDownloadDialog, ArchiveDownloadProvider, useArchiveDownload } from '../ArchiveDownloadContext';
import { DownloadQuotaProvider, useDownloadQuota } from '../DownloadQuotaContext';
import { DownloadChoiceContext, useDownloadChoice } from '../DownloadChoiceContext';

vi.mock('../../services/gallery.service', () => ({ galleryService: { startDownloadJob: vi.fn().mockResolvedValue({ token: 'job', status: 'pending' }) } }));
vi.mock('../../components/gallery/DownloadResolutionModal', () => ({ DownloadResolutionModal: () => {
  const quota = useDownloadQuota();
  const choice = useDownloadChoice();
  return <div role="dialog">{quota.limited ? `${quota.remaining} remaining` : 'unlimited'} · {choice.watermarked ? 'watermarked' : 'clean'}</div>;
} }));

function Start() {
  const downloads = useArchiveDownload();
  return <button onClick={() => void downloads.downloadAllPhotos('party')}>Prepare</button>;
}

it('renders the shared dialog within live gallery quota and rendition contexts', async () => {
  const client = new QueryClient();
  const tree = (remaining: number) => <QueryClientProvider client={client}>
    <ArchiveDownloadProvider renderDialog={false}>
      <DownloadQuotaProvider slug="party" event={{ download_limit: 5, downloads_remaining: remaining }}>
        <DownloadChoiceContext.Provider value={{ watermarked: true, choose: (_photo, start) => start() }}>
          <Start /><ArchiveDownloadDialog />
        </DownloadChoiceContext.Provider>
      </DownloadQuotaProvider>
    </ArchiveDownloadProvider>
  </QueryClientProvider>;
  const { rerender } = render(tree(3));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('3 remaining · watermarked');
  rerender(tree(1));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog')).toHaveTextContent('1 remaining · watermarked');
});
