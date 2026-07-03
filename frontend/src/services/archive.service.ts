import { api } from '../config/api';

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

export interface ArchiveDetails extends Archive {
  adminEmail: string;
  welcomeMessage?: string;
  colorTheme?: string;
  createdAt: string;
  photos: Array<{
    filename: string;
    type: string;
    size_bytes: number;
    uploaded_at: string;
  }>;
  archiveFile?: {
    size: number;
    createdAt: string;
    path: string;
  };
}

export interface ArchivesResponse {
  archives: Archive[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const archiveService = {
  // Get all archives with pagination
  async getArchives(page: number = 1, limit: number = 20): Promise<ArchivesResponse> {
    const response = await api.get<ArchivesResponse>('/admin/archives', {
      params: { page, limit }
    });
    return response.data;
  },

  // Get single archive details
  async getArchiveDetails(id: number): Promise<ArchiveDetails> {
    const response = await api.get<ArchiveDetails>(`/admin/archives/${id}`);
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

    // Create download link
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  // Delete archive permanently
  async deleteArchive(id: number): Promise<void> {
    await api.delete(`/admin/archives/${id}`);
  },

  // Format bytes to human readable
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
};