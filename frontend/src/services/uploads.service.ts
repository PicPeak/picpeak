import { api } from '../config/api';

export type PhotoProcessingStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface UploadPhotoStatus {
  id: number;
  filename: string;
  original_filename: string;
  status: PhotoProcessingStatus;
  error: string | null;
}

export interface UploadStatusSnapshot {
  upload_id: string;
  event_id: number;
  total: number;
  pending: number;
  processing: number;
  complete: number;
  failed: number;
  photos: UploadPhotoStatus[];
}

export const uploadsService = {
  /**
   * One-shot snapshot of an upload group's processing state. Frontends
   * poll this every 1.5s while any photo is still pending/processing.
   */
  async getStatus(uploadId: string): Promise<UploadStatusSnapshot> {
    const response = await api.get<UploadStatusSnapshot>(`/admin/uploads/${uploadId}/status`);
    return response.data;
  },

  /**
   * Retry a failed photo. Flips status back to 'pending' so the
   * background worker picks it up again.
   */
  async retryPhoto(photoId: number): Promise<{ id: number; status: PhotoProcessingStatus }> {
    const response = await api.post<{ id: number; status: PhotoProcessingStatus }>(
      `/admin/photos/${photoId}/retry`
    );
    return response.data;
  },

  /**
   * Build the SSE stream URL for an upload group. Caller is responsible
   * for opening an EventSource and merging the JSON-payload events into
   * their progress state. Falls back to polling getStatus() if the
   * EventSource fails to open (proxy buffering, etc.).
   */
  streamUrl(uploadId: string): string {
    // EventSource doesn't send our auth headers, so we have to rely on
    // the cookie-based admin session. (PicPeak's auth middleware reads
    // cookies before falling back to Authorization headers.)
    return `${api.defaults.baseURL || ''}/admin/uploads/${uploadId}/stream`;
  },
};
