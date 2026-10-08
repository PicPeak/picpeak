import { api } from '../config/api';

export interface ExternalEntry {
  name: string;
  /** Absolute root-relative path for a virtual approved source entry. */
  path?: string;
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
  async getSources(): Promise<ExternalSourcesResponse> {
    const res = await api.get<ExternalSourcesResponse>('/admin/external-media/sources');
    return res.data;
  },

  async assignSource(path: string, ownerId: number): Promise<void> {
    await api.put('/admin/external-media/sources', { path, owner_id: ownerId });
  },

  async revokeSource(id: number): Promise<void> {
    await api.delete(`/admin/external-media/sources/${id}`);
  },

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

export interface ExternalSourcesResponse {
  sources: Array<{ id: number; path: string; owner_id: number | null }>;
  can_assign: boolean;
  owners: Array<{ id: number; username: string }>;
}
