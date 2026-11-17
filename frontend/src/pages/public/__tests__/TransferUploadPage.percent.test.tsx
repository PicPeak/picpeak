/**
 * The client upload page says how far the upload is, not only a bar.
 *
 * A photographer's client sending a 1.7 GB file saw a thin bar and nothing
 * else for many minutes. The page now shows the percentage, as the admin
 * upload does, and "saving" once the last byte is out while the server
 * merges and stores the file.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (k: string, d?: unknown, o?: Record<string, unknown>) => {
      const opts = (typeof d === 'object' && d ? d : o || {}) as Record<string, unknown>;
      const text = typeof d === 'string' ? d : (opts.defaultValue as string | undefined) ?? k;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts[name]));
    },
  }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() } }));
vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => undefined }));
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
const ok = { uploaded: 1, files: [], rejected_files: [], failed_files: [] };

function sized(name: string, size: number) {
  const file = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function startUpload(files: File[]) {
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

describe('TransferUploadPage: upload progress', () => {
  let report: (pct: number) => void = () => {};
  let finish: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transfersService.getUploadInfo).mockResolvedValue(info as never);
    vi.mocked(transfersService.uploadChunked).mockImplementation((_token, _file, onProgress) => {
      report = (pct) => onProgress?.(pct);
      return new Promise((resolve) => { finish = () => resolve(ok as never); });
    });
  });

  it('shows the percentage sent next to an accessible progress bar', async () => {
    await startUpload([sized('film.mp4', 1700 * MB)]);
    await waitFor(() => expect(transfersService.uploadChunked).toHaveBeenCalled());

    report(42);
    expect(await screen.findByText('Uploading… 42%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Upload progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('does not say "saving" while the last bytes are still on the way', async () => {
    await startUpload([sized('film.mp4', 1700 * MB)]);
    await waitFor(() => expect(transfersService.uploadChunked).toHaveBeenCalled());

    // 99.6 % of 1.7 GB is ~7 MB still unsent.
    report(99.6);
    expect(await screen.findByText('Uploading… 99%')).toBeInTheDocument();
    expect(screen.queryByText('Upload complete, saving the files…')).toBeNull();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
  });

  it('says the files are being saved once every byte is sent', async () => {
    await startUpload([sized('film.mp4', 1700 * MB)]);
    await waitFor(() => expect(transfersService.uploadChunked).toHaveBeenCalled());

    report(100);
    expect(await screen.findByText('Upload complete, saving the files…')).toBeInTheDocument();
    expect(screen.queryByText(/Uploading…/)).toBeNull();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    finish();
    await waitFor(() => expect(screen.getByText('Thank you!')).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
