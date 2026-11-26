import { api } from '../config/api';
import { formatBytes } from '../utils/formatBytes';
import { saveBlob } from '../utils/saveBlob';

export interface Archive {
  id: number;
  slug: string;
  eventName: string;
  eventDate: string;
  eventType: string;
  hostEmail: string;
  archivedAt: string;
  expiresAt: string;
  photoCount: number;
  originalSize: number;
  archiveSize: number;
  archivePath?: string;
}

export type ArchiveSortBy = 'date' | 'name' | 'size';

export interface ArchivesResponse {
  archives: Archive[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  // Aggregates over the whole filtered set, not the page — the stat cards
  // summed the loaded rows, so they described 20 archives out of 802.
  totals?: {
    archives: number;
    photos: number;
    archiveSize: number;
  };
}

export const archiveService = {
  // Get all archives — pagination, search, type filter and sort are all
  // resolved server-side so they apply to the whole archive table.
  async getArchives(
    page: number = 1,
    limit: number = 20,
    search?: string,
    type?: string,
    sortBy?: ArchiveSortBy
  ): Promise<ArchivesResponse> {
    const response = await api.get<ArchivesResponse>('/admin/archives', {
      params: { page, limit, search: search || undefined, type: type || undefined, sortBy }
    });
    return response.data;
  },

  // Restore archive
  async restoreArchive(id: number): Promise<void> {
    await api.post(`/admin/archives/${id}/restore`);
  },

  // Download archive
  async downloadArchive(id: number, filename: string): Promise<void> {
    const response = await api.get(`/admin/archives/${id}/download`, {
      responseType: 'blob'
    });
    saveBlob(response.data, filename);
  },

  // Delete archive permanently
  async deleteArchive(id: number): Promise<void> {
    await api.delete(`/admin/archives/${id}`);
  },

  formatBytes,
};