/**
 * A large selection survives the upload route's per-minute limit.
 *
 * With the files-per-upload limit raised (issue 1914) one selection can be
 * more requests than the route allows per minute. Its refusal is a plain 429
 * with Retry-After; the page used to stop there, halfway through a valid
 * upload. It now waits that long and sends the same request again. A refusal
 * that carries an error code is a decision, not a pause, and still stops.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() } }));
vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => undefined }));
vi.mock('../../../services/transfers.service', () => ({
  transfersService: { getUploadInfo: vi.fn(), upload: vi.fn() },
}));
import { toast } from 'react-toastify';
import { transfersService } from '../../../services/transfers.service';
import { TransferUploadPage } from '../TransferUploadPage';

const info = {
  title: 'Send your photos', message: null, expires_at: '2026-11-01T00:00:00.000Z', max_size_mb: 50, max_files: 300,
  max_request_bytes: 100 * 1024 * 1024, accept_all: true, allowed_mime: [], allowed_extensions: [],
};
const refusal = (data: unknown, retryAfter = '2') => ({ response: { status: 429, data, headers: { 'retry-after': retryAfter } } });

async function pickAndUpload() {
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
  fireEvent.change(input, { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
  fireEvent.click(await screen.findByRole('button', { name: /Upload/ }));
}

describe('TransferUploadPage: a refused upload request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(transfersService.getUploadInfo).mockResolvedValue(info as never);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('waits out the rate limit and sends the same request again', async () => {
    vi.mocked(transfersService.upload)
      .mockRejectedValueOnce(refusal('Too many requests, please try again later.'))
      .mockResolvedValueOnce({ uploaded: 1, rejected_files: [], failed_files: [] } as never);

    await pickAndUpload();
    await waitFor(() => expect(transfersService.upload).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);

    await waitFor(() => expect(transfersService.upload).toHaveBeenCalledTimes(2));
    expect(vi.mocked(transfersService.upload).mock.calls[1][1]).toBe(vi.mocked(transfersService.upload).mock.calls[0][1]);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still stops at once on a refusal that carries an error code', async () => {
    vi.mocked(transfersService.upload).mockRejectedValueOnce(refusal({ error: 'Locked', code: 'TOKEN_LOOKUP_LOCKED' }));

    await pickAndUpload();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);

    expect(transfersService.upload).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });
});
