import React, { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveDownloadProvider, useArchiveDownload } from '../ArchiveDownloadContext';
import { galleryService } from '../../services/gallery.service';
import { markGalleryLimited } from '../../utils/downloadLimit';

vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: string) => fallback || key;
  return { initReactI18next: { type: '3rdParty', init: vi.fn() }, useTranslation: () => ({ t }) };
});
vi.mock('../../components/gallery/hooks/useGalleryDialog', () => ({ useGalleryDialog: vi.fn() }));
vi.mock('../../services/gallery.service', async () => ({
  ...await vi.importActual('../../services/gallery.service'),
  galleryService: {
    startDownloadJob: vi.fn(), getDownloadJob: vi.fn(), downloadJobFile: vi.fn(),
    downloadCachedArchive: vi.fn(), trySaveSelectedToDevice: vi.fn(), requestDownloadJobMail: vi.fn(),
  },
}));
const ready = { status: 'ready' as const, resolution: 'original', photo_count: 2, size_bytes: 500 };

function Actions({ parts = false }: { parts?: boolean }) {
  const downloads = useArchiveDownload();
  const [result, setResult] = useState('selected');
  const selected = async () => {
    const ids = parts ? Array.from({ length: 503 }, (_, i) => i + 1) : [1, 2];
    const done = await downloads[parts ? 'downloadPhotosInParts' : 'downloadSelectedPhotos']('party', ids);
    setResult(done ? 'handed off' : 'selected');
  };
  return <>
    <input aria-label="Browsing state" />
    <button onClick={selected}>Selection</button>
    <button onClick={() => downloads.downloadAllPhotos('party', true)}>Cached</button>
    <output>{result}</output>
  </>;
}
const view = (parts = false) => render(<StrictMode><ArchiveDownloadProvider><Actions parts={parts} /></ArchiveDownloadProvider></StrictMode>);

beforeEach(() => {
  vi.clearAllMocks();
  markGalleryLimited('party', false);
  vi.mocked(galleryService.startDownloadJob).mockResolvedValue({ token: 'job', status: 'ready', resolution: 'original' });
  vi.mocked(galleryService.getDownloadJob).mockResolvedValue(ready);
  vi.mocked(galleryService.trySaveSelectedToDevice).mockResolvedValue('fallback');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('shared archive preparation', () => {
  it('starts once under StrictMode and hands the ready file to the browser', async () => {
    view(); fireEvent.click(screen.getByText('Selection'));
    await screen.findByRole('button', { name: 'Download' });
    expect(galleryService.startDownloadJob).toHaveBeenCalledExactlyOnceWith('party', undefined, [1, 2]);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await screen.findByText('handed off');
    expect(galleryService.downloadJobFile).toHaveBeenCalledExactlyOnceWith('party', 'job', undefined, true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps the selection on close and ignores a late start response', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(galleryService.startDownloadJob).mockReturnValue(new Promise((r) => { resolve = r; }));
    view(); fireEvent.click(screen.getByText('Selection'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => { resolve({ token: 'late', status: 'ready', resolution: 'original' }); });
    expect(screen.getByText('selected')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(galleryService.downloadJobFile).not.toHaveBeenCalled();
  });
  it('keeps a stale file in the dialog and never navigates to it', async () => {
    vi.mocked(galleryService.getDownloadJob).mockResolvedValue({ ...ready, unavailable: true });
    view(); fireEvent.click(screen.getByText('Selection'));
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByText('This download is no longer available. Please request it again.');
    expect(galleryService.downloadJobFile).not.toHaveBeenCalled();
    expect(screen.getByText('selected')).toBeInTheDocument();
  });
  it('keeps a failed preflight visible without navigating', async () => {
    vi.mocked(galleryService.getDownloadJob).mockRejectedValue(new Error('offline'));
    view(); fireEvent.click(screen.getByText('Selection'));
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByText('Preparation failed');
    expect(galleryService.downloadJobFile).not.toHaveBeenCalled();
    expect(screen.getByText('selected')).toBeInTheDocument();
  });
  it('cancels a preparation on an access change while preserving the browsing view', async () => {
    const tree = (scopeKey: string) => <ArchiveDownloadProvider scopeKey={scopeKey}><Actions /></ArchiveDownloadProvider>;
    const { rerender } = render(tree('guest'));
    fireEvent.change(screen.getByLabelText('Browsing state'), { target: { value: 'keep this view' } });
    fireEvent.click(screen.getByText('Selection'));
    await screen.findByRole('dialog');
    rerender(tree('client'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Browsing state')).toHaveValue('keep this view');
    expect(galleryService.downloadJobFile).not.toHaveBeenCalled();
  });
  it('retries a failed preparation without losing the original action', async () => {
    vi.mocked(galleryService.startDownloadJob).mockRejectedValueOnce(new Error('offline'));
    view(); fireEvent.click(screen.getByText('Selection'));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByText('handed off');
    expect(galleryService.startDownloadJob).toHaveBeenCalledTimes(2);
  });
  it('keeps long builds preparing beyond the former ten-minute UI timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(galleryService.startDownloadJob).mockResolvedValue({ token: 'job', status: 'pending', resolution: 'original' });
    vi.mocked(galleryService.getDownloadJob).mockResolvedValue({ ...ready, status: 'building' });
    view();
    await act(async () => { fireEvent.click(screen.getByText('Selection')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60 * 1000); });
    expect(screen.getByText('Preparing your download…')).toBeInTheDocument();
    vi.mocked(galleryService.getDownloadJob).mockResolvedValue(ready);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
  it('preserves a dismissed iOS selection without preparing a ZIP', async () => {
    vi.mocked(galleryService.trySaveSelectedToDevice).mockResolvedValue('dismissed');
    view(); fireEvent.click(screen.getByText('Selection'));
    await waitFor(() => expect(galleryService.trySaveSelectedToDevice).toHaveBeenCalled());
    expect(galleryService.startDownloadJob).not.toHaveBeenCalled();
    expect(screen.getByText('selected')).toBeInTheDocument();
  });
  it('preserves the native ready-cache path and prepares limited galleries instead', async () => {
    view(); fireEvent.click(screen.getByText('Cached'));
    expect(galleryService.downloadCachedArchive).toHaveBeenCalledExactlyOnceWith('party');
    markGalleryLimited('party', true);
    fireEvent.click(screen.getByText('Cached'));
    await screen.findByRole('button', { name: 'Download' });
    expect(galleryService.startDownloadJob).toHaveBeenCalledExactlyOnceWith('party', undefined, undefined);
  });
  it('prepares count-capped parts sequentially, with native filenames and no share sheet', async () => {
    view(true); fireEvent.click(screen.getByText('Selection'));
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(galleryService.startDownloadJob).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByText('handed off');
    expect(vi.mocked(galleryService.startDownloadJob).mock.calls.map((call) => call[2]?.length)).toEqual([500, 3]);
    expect(vi.mocked(galleryService.downloadJobFile).mock.calls.map((call) => call[2])).toEqual([
      { index: 1, total: 2 }, { index: 2, total: 2 },
    ]);
    expect(galleryService.trySaveSelectedToDevice).not.toHaveBeenCalled();
  });
  it('stops remaining parts when the next preparation is dismissed after a failure', async () => {
    vi.mocked(galleryService.startDownloadJob)
      .mockResolvedValueOnce({ token: 'first', status: 'ready', resolution: 'original' })
      .mockRejectedValueOnce(new Error('offline'));
    view(true); fireEvent.click(screen.getByText('Selection'));
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByText('Preparation failed');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    await screen.findByText('selected');
    expect(galleryService.startDownloadJob).toHaveBeenCalledTimes(2);
    expect(galleryService.downloadJobFile).toHaveBeenCalledTimes(1);
  });
});
