import { api } from '../config/api';
import type { EditParams } from '../features/photo-editor/editMath';

/** A photo's edit as the editor opens it (issue 2619). */
export interface PhotoEditState {
  photo_id: number;
  /** A camera RAW the server develops: the editor works on its 16-bit develop. */
  raw: boolean;
  /** Names the original's bytes; the base and develop URLs carry it. */
  source_version: string;
  params: EditParams | null;
  edit_rev: number;
  edit_applied_rev: number;
  /** The upright original: crops are fractions of it. */
  width: number | null;
  height: number | null;
  edited_width: number | null;
  edited_height: number | null;
}

export interface PhotoEditStatus {
  pending: number;
  failed: number;
  pending_ids: number[];
  failed_ids: number[];
}

export interface PhotoEditPreset {
  id: number;
  name: string;
  params: EditParams;
}

export type EditPart = 'tone' | 'geometry';

const base = (eventId: number) => `/admin/photos/${eventId}/photos`;

export const photoEditorService = {
  async get(eventId: number, photoId: number): Promise<PhotoEditState> {
    return (await api.get<PhotoEditState>(`${base(eventId)}/${photoId}/edit`)).data;
  },

  /** The unedited photo at 1920 px, the editor's canvas. `version` is the state's source_version, for the cache. */
  async baseImage(eventId: number, photoId: number, version: string, signal?: AbortSignal): Promise<Blob> {
    const response = await api.get(`${base(eventId)}/${photoId}/edit/base`, {
      params: { v: version },
      responseType: 'blob',
      signal,
    });
    return response.data as Blob;
  },

  /**
   * A RAW photo's develop preview: 16-bit linear RGB at about 2048 px with
   * the server's header ("PPDV", a length, JSON, then the samples).
   */
  async developPreview(eventId: number, photoId: number, version: string, signal?: AbortSignal): Promise<{ width: number; height: number; data: Uint16Array; exposureBias: number }> {
    const response = await api.get(`${base(eventId)}/${photoId}/edit/develop`, { params: { v: version }, responseType: 'arraybuffer', signal });
    const buffer = response.data as ArrayBuffer;
    const view = new DataView(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magic !== 'PPDV') throw new Error('Not a develop preview');
    const length = view.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length)));
    const start = 8 + length;
    const samples = header.width * header.height * 3;
    // Copied so the samples sit on a 2-byte boundary whatever the header's length.
    const data = new Uint16Array(buffer.slice(start, start + samples * 2));
    return { width: header.width, height: header.height, data, exposureBias: Number(header.exposureBias) || 0 };
  },

  /** Develop RAW photos with the default look: these, or all of the gallery's. */
  async developRaw(eventId: number, target: { photoIds?: number[]; all?: boolean }): Promise<{ queued: number; photo_ids: number[] }> {
    const body = target.all ? { all: true } : { photo_ids: target.photoIds };
    return (await api.post(`${base(eventId)}/edit/develop`, body)).data;
  },

  async settings(): Promise<{ auto_develop_raw: boolean }> {
    return (await api.get('/admin/photo-edit-presets/settings')).data;
  },

  async saveSettings(value: { auto_develop_raw: boolean }): Promise<{ auto_develop_raw: boolean }> {
    return (await api.put('/admin/photo-edit-presets/settings', value)).data;
  },

  /** Save an edit; null resets the photo to its original. */
  async save(eventId: number, photoId: number, params: EditParams | null): Promise<PhotoEditState> {
    return (await api.put<PhotoEditState>(`${base(eventId)}/${photoId}/edit`, { params })).data;
  },

  async copyTo(eventId: number, photoIds: number[], params: EditParams, parts: EditPart[]): Promise<{ queued: number; skipped: number[] }> {
    return (await api.post(`${base(eventId)}/edit/batch`, { photo_ids: photoIds, params, parts })).data;
  },

  /** The gallery's edits still to apply; with `ids` (at most 500), only those photos'. */
  async status(eventId: number, ids?: number[]): Promise<PhotoEditStatus> {
    const params = ids ? { ids: ids.join(',') } : undefined;
    return (await api.get<PhotoEditStatus>(`${base(eventId)}/edit/status`, { params })).data;
  },

  async listPresets(): Promise<PhotoEditPreset[]> {
    return (await api.get<{ presets: PhotoEditPreset[] }>('/admin/photo-edit-presets')).data.presets;
  },

  async createPreset(name: string, params: EditParams): Promise<PhotoEditPreset> {
    return (await api.post<PhotoEditPreset>('/admin/photo-edit-presets', { name, params })).data;
  },

  async deletePreset(id: number): Promise<void> {
    await api.delete(`/admin/photo-edit-presets/${id}`);
  },
};
