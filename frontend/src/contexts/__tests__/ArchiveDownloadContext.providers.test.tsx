import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ArchiveDownloadDialog, ArchiveDownloadProvider, useArchiveDownload } from '../ArchiveDownloadContext';
import { DownloadQuotaProvider, useDownloadQuota } from '../DownloadQuotaContext';
import { galleryService } from '../../services/gallery.service';
import { DownloadChoiceContext, useDownloadChoice } from '../DownloadChoiceContext';

vi.mock('../../services/gallery.service', () => ({ galleryService: { startDownloadJob: vi.fn().mockResolvedValue({ token: 'job', status: 'pending' }) } }));
vi.mock('../../components/gallery/DownloadResolutionModal', () => ({ DownloadResolutionModal: () => {
  const quota = useDownloadQuota();
  const choice = useDownloadChoice();
  return <div role="dialog">{quota.limited ? `${quota.remaining} remaining` : 'unlimited'} · {choice.watermarked ? 'watermarked' : 'clean'}</div>;
} }));

function Start() {
  const downloads = useArchiveDownload();
  const [result, setResult] = useState('idle');
  return <>
    <button onClick={() => void downloads.downloadAllPhotos('party').then((done) => setResult(String(done)))}>Prepare</button>
    <output>{result}</output>
  </>;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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

it('settles a preparation when its gallery becomes unavailable without waiting for a scope change', async () => {
  const tree = (available: boolean) => <ArchiveDownloadProvider renderDialog={false} scopeKey="party:guest">
    <Start /><ArchiveDownloadDialog available={available} />
  </ArchiveDownloadProvider>;
  const { rerender } = render(tree(true));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  rerender(tree(false));
  await waitFor(() => expect(screen.getByText('false')).toBeInTheDocument());
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(tree(true));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(galleryService.startDownloadJob).toHaveBeenCalledTimes(2);
});
