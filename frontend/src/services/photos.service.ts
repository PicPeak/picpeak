import { api } from '../config/api';
import { parseContentDispositionFilename } from '../utils/contentDisposition';

export interface AdminPhoto {
  id: number;
  filename: string;
  original_filename?: string;
  path: string;
  url: string;
  thumbnail_url: string | null;
  type: string;
  category_id: number | string | null;
  category_name: string | null;
  category_slug: string | null;
  size: number;
  uploaded_at: string;
  media_type?: 'photo' | 'video';
  mime_type?: string | null;
  view_count?: number;
  download_count?: number;
  // Feedback fields
  has_feedback?: boolean;
  average_rating?: number;
  comment_count?: number;
  like_count?: number;
  favorite_count?: number;
}

export interface PhotoFilters {
  category_id?: number | string | null;
  type?: string;
  media_type?: 'photo' | 'video';
  search?: string;
  sort?: 'date' | 'name' | 'size' | 'rating';
  order?: 'asc' | 'desc';
  hasLikes?: boolean;
  hasFavorites?: boolean;
  hasComments?: boolean;
  minRating?: number | null;
  logic?: 'AND' | 'OR';
}

class PhotosService {
  async getEventPhotos(eventId: number, filters?: PhotoFilters): Promise<AdminPhoto[]> {
    const params = new URLSearchParams();
    
    if (filters) {
      if (filters.category_id !== undefined) {
        params.append('category_id', filters.category_id?.toString() || '');
      }
      if (filters.type) params.append('type', filters.type);
      if (filters.media_type) params.append('media_type', filters.media_type);
      if (filters.search) params.append('search', filters.search);
      if (filters.sort) params.append('sort', filters.sort);
      if (filters.order) params.append('order', filters.order);
      if (filters.hasLikes) params.append('has_likes', 'true');
      if (filters.hasFavorites) params.append('has_favorites', 'true');
      if (filters.hasComments) params.append('has_comments', 'true');
      if (filters.minRating !== undefined && filters.minRating !== null) {
        params.append('min_rating', filters.minRating.toString());
      }
      if (filters.logic) params.append('logic', filters.logic);
    }
    
    const queryString = params.toString();
    // Use admin photos router for listing to ensure URL alignment with media/thumbnail endpoints
    const url = `/admin/photos/${eventId}/photos${queryString ? `?${queryString}` : ''}`;
    
    const response = await api.get(url);
    
    // Return photos as-is, URLs are already relative API paths
    return response.data.photos;
  }

  async deletePhoto(eventId: number, photoId: number): Promise<void> {
    await api.delete(`/admin/events/${eventId}/photos/${photoId}`);
  }

  async deletePhotos(eventId: number, photoIds: number[]): Promise<void> {
    await api.post(`/admin/events/${eventId}/photos/bulk-delete`, { photoIds });
  }

  async updatePhotoCategory(eventId: number, photoId: number, categoryId: number | string | null): Promise<AdminPhoto> {
    const response = await api.patch(`/admin/events/${eventId}/photos/${photoId}`, { category_id: categoryId });
    return response.data.photo;
  }

  async updatePhotosCategory(eventId: number, photoIds: number[], categoryId: number | null): Promise<void> {
    await api.post(`/admin/events/${eventId}/photos/bulk-update`, {
      photoIds,
      updates: { category_id: categoryId }
    });
  }

  async bulkUpdatePhotos(eventId: number, photoIds: number[], updates: Record<string, unknown>): Promise<void> {
    await api.post(`/admin/events/${eventId}/photos/bulk-update`, {
      photoIds,
      updates
    });
  }

  async downloadPhoto(eventId: number, photoId: number, filename: string): Promise<void> {
    const response = await api.get(`/admin/events/${eventId}/photos/${photoId}/download`, {
      responseType: 'blob'
    });

    // Read the filename from the server's Content-Disposition so the
    // #493 original-filename toggle reaches disk for admin downloads
    // too (see contentDisposition.ts).
    const headerName =
      response.headers['content-disposition'] || response.headers['Content-Disposition'];
    const serverFilename = parseContentDispositionFilename(headerName);

    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.download = serverFilename || filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Chunked upload methods for large files (videos up to 10GB)
  private CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks

  async initChunkedUpload(
    eventId: number,
    filename: string,
    fileSize: number,
    mimeType: string
  ): Promise<{ uploadId: string; chunkSize: number; expectedChunks: number }> {
    const totalChunks = Math.ceil(fileSize / this.CHUNK_SIZE);
    const response = await api.post(`/admin/photos/${eventId}/chunked-upload/init`, {
      filename,
      fileSize,
      mimeType,
      totalChunks
    });
    return response.data;
  }

  async uploadChunk(
    eventId: number,
    uploadId: string,
    chunkIndex: number,
    chunkData: Blob
  ): Promise<{ progress: number; complete: boolean }> {
    const response = await api.post(
      `/admin/photos/${eventId}/chunked-upload/${uploadId}/chunk/${chunkIndex}`,
      chunkData,
      {
        headers: {
          'Content-Type': 'application/octet-stream'
        }
      }
    );
    return response.data;
  }

  async completeChunkedUpload(
    eventId: number,
    uploadId: string,
    categoryId?: number | null
  ): Promise<{ success: boolean; uploaded: number; photos: AdminPhoto[] }> {
    const response = await api.post(
      `/admin/photos/${eventId}/chunked-upload/${uploadId}/complete`,
      { category_id: categoryId }
    );
    return response.data;
  }

  async abortChunkedUpload(eventId: number, uploadId: string): Promise<void> {
    await api.delete(`/admin/photos/${eventId}/chunked-upload/${uploadId}`);
  }

  async uploadLargeFile(
    eventId: number,
    file: File,
    categoryId?: number | null,
    onProgress?: (progress: number) => void
  ): Promise<AdminPhoto[]> {
    // Initialize upload
    const { uploadId, expectedChunks } = await this.initChunkedUpload(
      eventId,
      file.name,
      file.size,
      file.type
    );

    try {
      // Upload chunks
      for (let i = 0; i < expectedChunks; i++) {
        const start = i * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const result = await this.uploadChunk(eventId, uploadId, i, chunk);

        if (onProgress) {
          onProgress(result.progress);
        }
      }

      // Complete upload
      const result = await this.completeChunkedUpload(eventId, uploadId, categoryId);
      return result.photos;
    } catch (error) {
      // Abort on error
      try {
        await this.abortChunkedUpload(eventId, uploadId);
      } catch (abortError) {
        console.error('Failed to abort upload:', abortError);
      }
      throw error;
    }
  }

  // Check if file should use chunked upload (> 100MB)
  shouldUseChunkedUpload(fileSize: number): boolean {
    return fileSize > 100 * 1024 * 1024; // 100MB threshold
  }

  // ============================================
  // Photo Filtering & Export Methods
  // ============================================

  async getFilteredPhotos(
    eventId: number,
    filters: FeedbackFilters
  ): Promise<FilteredPhotosResponse> {
    const params = new URLSearchParams();

    if (filters.minRating !== undefined && filters.minRating !== null) {
      params.append('min_rating', filters.minRating.toString());
    }
    if (filters.hasLikes) params.append('has_likes', 'true');
    if (filters.hasFavorites) params.append('has_favorites', 'true');
    if (filters.hasComments) params.append('has_comments', 'true');
    if (filters.categoryId) params.append('category_id', filters.categoryId.toString());
    if (filters.logic) params.append('logic', filters.logic);
    if (filters.sort) params.append('sort', filters.sort);
    if (filters.order) params.append('order', filters.order);
    if (filters.page) params.append('page', filters.page.toString());
    if (filters.limit) params.append('limit', filters.limit.toString());

    const queryString = params.toString();
    const url = `/admin/photo-export/${eventId}/filtered${queryString ? `?${queryString}` : ''}`;

    const response = await api.get(url);
    return response.data.data;
  }

  async getFilterSummary(eventId: number): Promise<FilterSummary> {
    const response = await api.get(`/admin/photo-export/${eventId}/filter-summary`);
    return response.data.data;
  }

  async exportPhotos(
    eventId: number,
    options: ExportOptions
  ): Promise<void> {
    const response = await api.post(
      `/admin/photo-export/${eventId}/export`,
      options,
      { responseType: 'blob' }
    );

    // Get filename from Content-Disposition header
    const contentDisposition = response.headers['content-disposition'];
    let filename = `export_${Date.now()}`;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
      if (filenameMatch) {
        filename = filenameMatch[1];
      }
    }

    // Download the file
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }

  async getExportFormats(): Promise<ExportFormat[]> {
    const response = await api.get('/admin/photo-export/export-formats');
    return response.data.data;
  }
}

// Types for filtering and export
export interface FeedbackFilters {
  minRating?: number | null;
  maxRating?: number | null;
  hasLikes?: boolean;
  minLikes?: number;
  hasFavorites?: boolean;
  minFavorites?: number;
  hasComments?: boolean;
  categoryId?: number;
  logic?: 'AND' | 'OR';
  sort?: 'rating' | 'likes' | 'favorites' | 'date' | 'filename';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface FilterSummary {
  total: number;
  withRatings: number;
  withLikes: number;
  withFavorites: number;
  withComments: number;
}

export interface FilteredPhotosResponse {
  photos: AdminPhoto[];
  pagination: {
    total: number;
    filtered: number;
    page: number;
    limit: number;
    pages: number;
  };
  summary: FilterSummary;
}

export interface ExportOptions {
  photo_ids?: number[];
  filter?: FeedbackFilters;
  format: 'txt' | 'csv' | 'xmp' | 'json';
  options?: {
    filename_format?: 'original' | 'picpeak';
    separator?: 'newline' | 'comma' | 'semicolon';
    include_rating?: boolean;
    include_label?: boolean;
    include_description?: boolean;
    include_keywords?: boolean;
  };
}

export interface ExportFormat {
  value: string;
  label: string;
  description: string;
}

export const photosService = new PhotosService();
