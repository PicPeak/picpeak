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

export interface ExternalImportStatus {
  is_running: boolean;
  /** When the last import of the gallery's folder finished (ISO), or null. */
  finished_at: string | null;
  /** The last run's outcome; `failed` with an `error` code when it threw. */
  last_result: {
    imported?: number;
    skipped?: number;
    failed?: boolean;
    error?: 'folder_missing' | 'permission_denied' | 'import_failed';
  } | null;
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
  },

  /** Import, or rescan, the folder the gallery's Photo source points at. */
  async rescanEvent(eventId: number): Promise<ExternalMediaImportResult> {
    const res = await api.post<ExternalMediaImportResult>(
      `/admin/external-media/events/${eventId}/import-external`,
      { recursive: true }
    );
    return res.data;
  },

  async getImportStatus(eventId: number): Promise<ExternalImportStatus> {
    const res = await api.get<ExternalImportStatus>(`/admin/external-media/events/${eventId}/status`);
    return res.data;
  }
};

export interface ExternalSourcesResponse {
  sources: Array<{ id: number; path: string; owner_id: number | null }>;
  can_assign: boolean;
  owners: Array<{ id: number; username: string }>;
}
