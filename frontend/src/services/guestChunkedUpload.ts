import type { AxiosResponse } from 'axios';
import { api } from '../config/api';

/**
 * One file sent in chunks over the server's init / chunk / complete protocol
 * under `basePath` (e.g. `/gallery/12`, `/admin/transfers/7`). Each chunk is
 * its own request of at most the server's chunk size (10 MB), so neither a
 * proxy's body limit (Cloudflare: 100 MB) nor a per-request timeout applies to
 * the whole file. A failure aborts the upload so its reservation is released
 * at once.
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
  try {
    for (let index = 0; index < expectedChunks; index++) {
      const start = index * chunkSize;
      await api.post(
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
    }
    // Merging and the content check can take a while on a large file.
    return await api.post<T>(`${basePath}/chunked-upload/${uploadId}/complete`, completeFields, { headers, timeout: 0 });
  } catch (error) {
    await api.delete(`${basePath}/chunked-upload/${uploadId}`, { headers }).catch(() => {});
    throw error;
  }
}

/**
 * A guest file too large for one request, sent in chunks (issue 2315): the
 * same protocol the admin upload uses, on the gallery's own routes. The
 * complete call answers exactly like POST /gallery/:eventId/upload.
 *
 * `headers` carries the gallery and guest tokens; `fields` the form fields the
 * single request would send (category_id, captured_at).
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
