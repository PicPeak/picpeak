import type { AxiosResponse } from 'axios';
import { api } from '../config/api';

/**
 * A guest file too large for one request, sent in chunks (issue 2315): the
 * same init / chunk / complete protocol the admin upload uses, on the
 * gallery's own routes. Each chunk is its own request, so neither a proxy's
 * body limit nor the public upload timeout applies to the whole file. The
 * complete call answers exactly like POST /gallery/:eventId/upload.
 *
 * `headers` carries the gallery and guest tokens; `fields` the form fields the
 * single request would send (category_id, captured_at). A failure aborts the
 * upload so its reservation is released at once.
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
  const init = await api.post<{ uploadId: string; chunkSize: number; expectedChunks: number }>(
    `/gallery/${eventId}/chunked-upload/init`,
    { filename: file.name, fileSize: file.size },
    { headers }
  );
  const { uploadId, chunkSize, expectedChunks } = init.data;
  try {
    for (let index = 0; index < expectedChunks; index++) {
      const start = index * chunkSize;
      await api.post(
        `/gallery/${eventId}/chunked-upload/${uploadId}/chunk/${index}`,
        file.slice(start, Math.min(start + chunkSize, file.size)),
        {
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          // A slow mobile link may take a while per chunk; the server bounds it.
          timeout: 0,
          onUploadProgress: (event) => {
            if (onProgress && file.size > 0) {
              onProgress(Math.min(100, Math.round(((start + (event.loaded || 0)) * 100) / file.size)));
            }
          },
        }
      );
    }
    // Merging and the content check can take a while on a large video.
    return await api.post<T>(`/gallery/${eventId}/chunked-upload/${uploadId}/complete`, fields, { headers, timeout: 0 });
  } catch (error) {
    await api.delete(`/gallery/${eventId}/chunked-upload/${uploadId}`, { headers }).catch(() => {});
    throw error;
  }
}
