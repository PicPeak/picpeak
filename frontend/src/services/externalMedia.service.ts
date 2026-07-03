import { api } from '../config/api';

export interface ExternalEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
}

export interface ExternalMediaListResponse {
  path: string;
  entries: ExternalEntry[];
  canNavigateUp: boolean;
}

export interface ExternalMediaImportOptions {
  recursive?: boolean;
  map?: { individual?: string; collages?: string };
}

export interface ExternalMediaImportResult {
  imported: number;
  skipped: number;
  thumbnailsQueued: number;
}

export const externalMediaService = {
  async list(pathRel: string = ''): Promise<ExternalMediaListResponse> {
    const params = new URLSearchParams();
    if (pathRel) params.set('path', pathRel);
    const res = await api.get<ExternalMediaListResponse>(`/admin/external-media/list?${params.toString()}`);
    return res.data;
  },

  async importEvent(
    eventId: number,
    externalPath: string,
    options?: ExternalMediaImportOptions
  ): Promise<ExternalMediaImportResult> {
    const res = await api.post<ExternalMediaImportResult>(
      `/admin/external-media/events/${eventId}/import-external`,
      {
        external_path: externalPath,
        recursive: options?.recursive ?? true,
        map: options?.map
      }
    );
    return res.data;
  }
};
