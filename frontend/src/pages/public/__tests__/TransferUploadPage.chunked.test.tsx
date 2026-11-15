/**
 * A client's file larger than one request goes up in chunks.
 *
 * The page split a selection into requests under the server's per-request
 * budget, but a single file above it still went in one request — which never
 * passes a proxy with a 100 MB body limit (Cloudflare Free/Pro). Such a file
 * now goes on its own through the chunked upload; smaller ones keep the
 * multipart requests.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() } }));
vi.mock('../../../services/transfers.service', () => ({
  transfersService: { getUploadInfo: vi.fn(), upload: vi.fn(), uploadChunked: vi.fn() },
}));
import { toast } from 'react-toastify';
import { transfersService } from '../../../services/transfers.service';
import { TransferUploadPage } from '../TransferUploadPage';

const MB = 1024 * 1024;
const info = {
  title: 'Send your photos', message: null, expires_at: '2026-11-01T00:00:00.000Z', max_size_mb: 2048, max_files: 25,
  // The server's own budget fits one file of the cap; the proxy does not.
  max_request_bytes: 2049 * MB, allowed_mime: ['video/mp4', 'image/jpeg'],
};
const ok = { uploaded: 1 };

function sized(name: string, size: number) {
  const file = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function pickAndUpload(files: File[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/transfer-upload/tok']}>
        <Routes><Route path="/transfer-upload/:token" element={<TransferUploadPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const input = await waitFor(() => {
    const found = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(found).not.toBeNull();
    return found as HTMLInputElement;
  });
  fireEvent.change(input, { target: { files } });
  fireEvent.click(await screen.findByRole('button', { name: /Upload/ }));
}

describe('TransferUploadPage: a file larger than one request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transfersService.getUploadInfo).mockResolvedValue(info as never);
    vi.mocked(transfersService.upload).mockResolvedValue(ok as never);
    vi.mocked(transfersService.uploadChunked).mockResolvedValue(ok as never);
  });

  it('goes in chunks, while small files keep the multipart request', async () => {
    const film = sized('film.mp4', 500 * MB);
    const small = sized('a.jpg', 2 * MB);
    await pickAndUpload([film, small]);

    await waitFor(() => expect(screen.getByText('Thank you!')).toBeInTheDocument());
    expect(transfersService.uploadChunked).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transfersService.uploadChunked).mock.calls[0][1]).toBe(film);
    expect(transfersService.upload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transfersService.upload).mock.calls[0][1]).toEqual([small]);
  });

  it('keeps a large file that failed on screen to retry', async () => {
    vi.mocked(transfersService.uploadChunked).mockRejectedValue({ response: { status: 500, data: { error: 'Could not store' } } });
    await pickAndUpload([sized('film.mp4', 500 * MB)]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not store'));
    expect(screen.queryByText('Thank you!')).toBeNull();
    expect(screen.getByText('film.mp4')).toBeInTheDocument();
  });
});
