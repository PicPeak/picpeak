/**
 * While a chunked upload waits to resume (connection dropped, page in the
 * background), the client page says so; the screen is kept awake while an
 * upload runs so a phone does not lock and suspend the page.
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
vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => undefined }));
const interrupted = vi.hoisted(() => ({ value: false }));
vi.mock('../../../hooks/useUploadInterrupted', () => ({ useUploadInterrupted: () => interrupted.value }));
const wakeLock = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/useScreenWakeLock', () => ({ useScreenWakeLock: wakeLock }));
vi.mock('../../../services/transfers.service', () => ({
  transfersService: { getUploadInfo: vi.fn(), upload: vi.fn(), uploadChunked: vi.fn() },
}));
import { transfersService } from '../../../services/transfers.service';
import { TransferUploadPage } from '../TransferUploadPage';

const MB = 1024 * 1024;
const info = {
  title: 'Send your photos', message: null, expires_at: '2026-11-01T00:00:00.000Z', max_size_mb: 2048, max_files: 25,
  max_request_bytes: 2049 * MB, accept_all: true, allowed_mime: [], allowed_extensions: [],
};

function sized(name: string, size: number) {
  const file = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function startUpload() {
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
  fireEvent.change(input, { target: { files: [sized('film.mp4', 1700 * MB)] } });
  fireEvent.click(await screen.findByRole('button', { name: /Upload/ }));
  await waitFor(() => expect(transfersService.uploadChunked).toHaveBeenCalled());
}

describe('TransferUploadPage: resuming an interrupted upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    interrupted.value = false;
    vi.mocked(transfersService.getUploadInfo).mockResolvedValue(info as never);
    vi.mocked(transfersService.uploadChunked).mockReturnValue(new Promise(() => {}));
  });

  it('says the connection was interrupted while the upload waits to resume', async () => {
    interrupted.value = true;
    await startUpload();
    expect(await screen.findByText('Connection interrupted – resuming…')).toBeInTheDocument();
  });

  it('shows no note while the upload runs normally', async () => {
    await startUpload();
    expect(screen.queryByText('Connection interrupted – resuming…')).toBeNull();
  });

  it('keeps the screen awake only while uploading', async () => {
    await startUpload();
    expect(wakeLock).toHaveBeenCalledWith(false);
    expect(wakeLock).toHaveBeenLastCalledWith(true);
  });
});
