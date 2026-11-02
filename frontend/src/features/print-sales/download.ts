import { api } from '../../config/api';

interface DownloadStatus { id: string; status: 'pending' | 'preparing' | 'downloading' | 'complete' | 'failed'; error?: string | null }
export class DownloadStatusUnavailable extends Error {}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/** Observe the actual native GET, without buffering the archive or verifying twice. */
export async function downloadPrintFile(id: string, kind: string, signal: AbortSignal, onStatus: (s: string) => void) {
  const path = `/admin/print-sales/orders/${id}/files/${kind}`;
  const { data: attempt } = await api.post<DownloadStatus>(`${path}/downloads`, {}, { signal });
  signal.throwIfAborted();
  const a = document.createElement('a');
  a.href = api.getUri({ url: path, params: { downloadId: attempt.id } });
  a.download = `print-${id}.${kind === 'pack' ? 'zip' : 'pdf'}`;
  document.body.appendChild(a); a.click(); a.remove();
  while (!signal.aborted) {
    let data: DownloadStatus;
    try { ({ data } = await api.get<DownloadStatus>(`${path}/downloads/${attempt.id}`, { signal, timeout: 15000 })); }
    catch (error) { if (signal.aborted) throw error; throw new DownloadStatusUnavailable(); }
    signal.throwIfAborted();
    if (data.status === 'failed') throw new Error(data.error || 'The file could not be downloaded.');
    onStatus(data.status);
    if (data.status === 'complete') return;
    await pause(signal);
  }
  signal.throwIfAborted();
}
