import type { AxiosResponse } from 'axios';
import { api } from '../config/api';

/**
 * Waits before re-sending a chunk that failed on the way: a dropped
 * connection, a timeout, a 500/502/504, 408, the 409 "Upload is busy" (the
 * server still finishing the previous attempt of that chunk) or a plain
 * rate-limit 429. About three minutes in all; a refusal (4xx) is never
 * retried. Neither is a 503: the api interceptor has already switched the
 * app to its maintenance screen, which unmounts the uploader, so going on
 * would store files behind a page that can no longer say so.
 */
export const CHUNK_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000, 30000];
// A Retry-After longer than this is not sat through silently.
const MAX_RETRY_AFTER_MS = 60000;

/**
 * The least wait before a failed chunk may go again, or null when the
 * failure is the server's answer to the request itself and must not be
 * repeated. Re-sending an index the server already holds replaces it
 * (chunkedUploadService.uploadChunk), so a retry is always safe.
 */
function chunkRetryFloorMs(error: unknown): number | null {
  const response = (error as {
    response?: { status?: number; data?: { code?: string }; headers?: Record<string, unknown> };
  })?.response;
  // No answer at all: the connection dropped, timed out, or the page was
  // suspended mid-request (iOS Safari in the background).
  if (!response) return 0;
  const status = response.status ?? 0;
  if (status === 429) {
    // A 429 with a code is a quota or lockout decision, not a pace.
    if (response.data?.code) return null;
    const seconds = Number(response.headers?.['retry-after']);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return seconds * 1000 <= MAX_RETRY_AFTER_MS ? seconds * 1000 : null;
  }
  // The only 409 worth repeating: a coded one (PHOTO_CAP_REACHED,
  // UPLOAD_RESERVATION_LOST, an upload no longer in progress) is final.
  if (status === 409) {
    return response.data?.code === 'UPLOAD_STATE' && (response.data as { error?: string }).error === 'Upload is busy'
      ? 0 : null;
  }
  if (status === 503) return null;
  return status >= 500 || status === 408 ? 0 : null;
}

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Resolves once the page is visible (at once when it already is). */
function whenVisible(): Promise<void> {
  if (!pageHidden()) return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (pageHidden()) return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Resolves once the page is visible and `deadline` (ms since epoch) has
 * passed, whichever comes last: coming back to the page does not cut a
 * backoff or a Retry-After short.
 */
async function resumeAt(deadline: number): Promise<void> {
  for (;;) {
    await whenVisible();
    const left = deadline - Date.now();
    if (left > 0) await sleep(left);
    else if (!pageHidden()) return;
  }
}

// How many uploads are waiting to resume after a failed chunk, for the
// "connection interrupted" note (useUploadInterrupted).
let interruptedUploads = 0;
const interruptionListeners = new Set<() => void>();

export function subscribeUploadInterruptions(listener: () => void): () => void {
  interruptionListeners.add(listener);
  return () => { interruptionListeners.delete(listener); };
}

export function isUploadInterrupted(): boolean {
  return interruptedUploads > 0;
}

function interruptionFlag() {
  let on = false;
  return (next: boolean) => {
    if (next === on) return;
    on = next;
    interruptedUploads += next ? 1 : -1;
    interruptionListeners.forEach((listener) => listener());
  };
}

/**
 * One file sent in chunks over the server's init / chunk / complete protocol
 * under `basePath` (e.g. `/gallery/12`, `/admin/transfers/7`). Each chunk is
 * its own request of at most the server's chunk size (10 MB), so neither a
 * proxy's body limit (Cloudflare: 100 MB) nor a per-request timeout applies to
 * the whole file.
 *
 * A chunk that fails on the way (see chunkRetryFloorMs) is sent again after
 * a backoff, from that chunk on; earlier chunks are not re-sent. While the
 * page is hidden (a phone's browser in the background suspends the page and
 * its requests fail) the retry waits for the page to be visible again and
 * does not count as an attempt. A refusal, or a chunk still failing after
 * every retry, aborts the upload so its reservation is released at once.
 *
 * `initFields` ride on the init body next to filename and fileSize and
 * `completeFields` are the complete body.
 * `onBytes` reports the bytes of this file sent so far, across chunks.
 */
export async function uploadFileInChunks<T>(
  basePath: string,
  file: File,
  {
    headers = {},
    initFields = {},
    completeFields = {},
    onBytes,
  }: {
    headers?: Record<string, string>;
    initFields?: Record<string, unknown>;
    completeFields?: Record<string, unknown>;
    onBytes?: (sentBytes: number) => void;
  } = {}
): Promise<AxiosResponse<T>> {
  const init = await api.post<{ uploadId: string; chunkSize: number; expectedChunks: number }>(
    `${basePath}/chunked-upload/init`,
    { filename: file.name, fileSize: file.size, ...initFields },
    { headers }
  );
  const { uploadId, chunkSize, expectedChunks } = init.data;
  const setInterrupted = interruptionFlag();
  try {
    for (let index = 0; index < expectedChunks; index++) {
      const start = index * chunkSize;
      const send = () => api.post(
        `${basePath}/chunked-upload/${uploadId}/chunk/${index}`,
        file.slice(start, Math.min(start + chunkSize, file.size)),
        {
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          // A slow mobile link may take a while per chunk; the server bounds it.
          timeout: 0,
          onUploadProgress: (event) => {
            onBytes?.(Math.min(file.size, start + (event.loaded || 0)));
          },
        }
      );
      for (let attempt = 0; ; ) {
        try {
          await send();
          break;
        } catch (error) {
          const floor = chunkRetryFloorMs(error);
          if (floor === null) throw error;
          setInterrupted(true);
          let wait = floor;
          // Failing while hidden is not the connection's fault: no attempt is
          // spent, the retry just waits for the user to come back.
          if (!pageHidden()) {
            if (attempt >= CHUNK_RETRY_DELAYS_MS.length) throw error;
            wait = Math.max(floor, CHUNK_RETRY_DELAYS_MS[attempt]);
            attempt += 1;
          }
          await resumeAt(Date.now() + wait);
        }
      }
      setInterrupted(false);
    }
    // Merging and the content check can take a while on a large file.
    return await api.post<T>(`${basePath}/chunked-upload/${uploadId}/complete`, completeFields, { headers, timeout: 0 });
  } catch (error) {
    await api.delete(`${basePath}/chunked-upload/${uploadId}`, { headers }).catch(() => {});
    throw error;
  } finally {
    setInterrupted(false);
  }
}

/**
 * A guest file too large for one request, sent in chunks (issue 2315): the
 * same protocol the admin upload uses, on the gallery's own routes. The
 * complete call answers exactly like POST /gallery/:eventId/upload.
 *
 * `headers` carries any extra request headers; `fields` the form fields the
 * single request would send (category_id).
 */
export async function uploadGuestFileInChunks<T>(
  eventId: number,
  file: File,
  {
    headers,
    fields,
    onProgress,
  }: {
    headers: Record<string, string>;
    fields: Record<string, string>;
    onProgress?: (percent: number) => void;
  }
): Promise<AxiosResponse<T>> {
  return uploadFileInChunks<T>(`/gallery/${eventId}`, file, {
    headers,
    completeFields: fields,
    onBytes: (sent) => {
      if (onProgress && file.size > 0) onProgress(Math.min(100, Math.round((sent * 100) / file.size)));
    },
  });
}
