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
  // Browser-playable copy of a video (issue 1430, item 8); null until the
  // setting has queued it.
  web_status?: 'pending' | 'processing' | 'complete' | 'skipped' | 'failed' | null;
  web_error?: string | null;
  processing_status?: 'pending' | 'processing' | 'complete' | 'failed';
  // Set on a complete video that shows the placeholder tile because no
  // poster frame could be taken (issue 1430, item 6).
  processing_error?: string | null;
  view_count?: number;
  download_count?: number;
  // Feedback fields
  has_feedback?: boolean;
  average_rating?: number;
  comment_count?: number;
  like_count?: number;
  favorite_count?: number;
  // Colour labels (#1044). `color_labels` is the per-colour tally across all
  // guests; `dominant_color_label` is the one the grid badge and the XMP
  // export use when several guests disagreed.
  color_label_count?: number;
  color_labels?: Record<string, number>;
  dominant_color_label?: string | null;
  // Approve / reject tallies across guests (issue 744).
  approved_count?: number;
  rejected_count?: number;
  // The requesting admin's OWN triage mark (#1044 follow-up) — separate from
  // the client's selections above, and never shown in the gallery.
  my_rating?: number | null;
  my_color_label?: string | null;
  // Photo credit (#1561). The admin always sees it, whatever the event's
  // show-to-guests switch says.
  credit_name?: string | null;
  credit_source?: 'guest' | 'exif' | 'manual' | 'account' | null;
  uploaded_by?: 'admin' | 'guest';
  // Folders (issue 1786): the folder the photo lives in (null = gallery
  // root), and the open folder request it waits on, if any.
  folder_id?: number | null;
  pending_folder_request_id?: number | null;
  // Delivered as part of a first look (issue 1562).
  first_look?: boolean;
  // Review of team members' uploads (issue 743): null = published as usual.
  moderation_status?: PhotoModerationStatus | null;
  // The admin account that ran the upload; null for imports and older rows.
  uploaded_by_admin?: { id: number; username: string | null } | null;
}

/** A photo a team member uploaded, waiting for the owner or turned down (issue 743). */
export type PhotoModerationStatus = 'pending' | 'rejected';

export interface PhotoModerationCounts {
  pending: number;
  rejected: number;
}

// Filter value for "photos without a credit" — mirrors CREDIT_NONE in
// backend/src/services/photoCredit.js.
export const CREDIT_FILTER_NONE = '__none__';

/** Admin filter on the guests' approve / reject (issue 744). */
export type DecisionFilter = 'approved' | 'rejected' | 'undecided';

export interface PhotoCreditSummary {
  credits: Array<{ name: string; count: number }>;
  none: number;
}

/** Sort keys of the admin photo list. `date` is the upload date. */
export type PhotoSortKey = 'date' | 'name' | 'size' | 'rating' | 'capture_date';

/**
 * Folder filter of the admin photo list (issue 1786): `root` = photos in no
 * folder, a number = the photos directly in that folder, `pending` = photos
 * waiting for a folder request. Absent = every photo.
 */
export type PhotoFolderFilter = number | 'root' | 'pending';

export interface PhotoFilters {
  category_id?: number | string | null;
  folder_id?: PhotoFolderFilter;
  type?: string;
  media_type?: 'photo' | 'video';
  search?: string;
  sort?: PhotoSortKey;
  order?: 'asc' | 'desc';
  hasLikes?: boolean;
  hasFavorites?: boolean;
  hasComments?: boolean;
  minRating?: number | null;
  /** Colour labels to keep, e.g. ['green'] (#1044). */
  colorLabels?: string[];
  /** Same, against the caller's own marks. */
  myColorLabels?: string[];
  /** Approve / reject (issue 744); several OR together. */
  decisions?: DecisionFilter[];
  /** Exact credit name, or CREDIT_FILTER_NONE (#1561). */
  credit?: string;
  /** Only the photos under review with this status (issue 743). */
  moderation?: PhotoModerationStatus;
  logic?: 'AND' | 'OR';
}

/**
 * Where one upload batch lands (issues 1786 + 1562). The folder fields come
 * from POST …/folders/resolve; one batch is one placement.
 */
export interface UploadPlacement {
  /** Filter category for every file of the batch. */
  categoryId?: number | null;
  /** Target folder; null/absent = gallery root. */
  folderId?: number | null;
  /** Open folder request the batch waits on (the server parks it in the request's fallback folder). */
  folderRequestId?: number | null;
  /** The batch came from a first-look keyword folder. */
  firstLook?: boolean;
}

/** The folder half of a placement, as the chunked-upload helpers take it. */
export type FolderPlacement = Omit<UploadPlacement, 'categoryId'>;

/**
 * Placement fields of the chunked complete body. category_id is always sent
 * (as before); the folder fields only when set, so a plain upload's body is
 * unchanged.
 */
export function uploadPlacementBody(placement: UploadPlacement): Record<string, number | boolean | null> {
  const body: Record<string, number | boolean | null> = { category_id: placement.categoryId ?? null };
  if (placement.folderId) body.folder_id = placement.folderId;
  if (placement.folderRequestId) body.folder_request_id = placement.folderRequestId;
  if (placement.firstLook) body.first_look = true;
  return body;
}

/** The same fields on a multipart upload; only the ones that are set. */
export function appendUploadPlacement(formData: FormData, placement: UploadPlacement): void {
  if (placement.categoryId) formData.append('category_id', placement.categoryId.toString());
  if (placement.folderId) formData.append('folder_id', placement.folderId.toString());
  if (placement.folderRequestId) formData.append('folder_request_id', placement.folderRequestId.toString());
  if (placement.firstLook) formData.append('first_look', 'true');
}

class PhotosService {
  /**
   * Set / change / clear the admin's own mark on a photo (#1044 follow-up).
   * Omit a field to leave that half alone; pass null to clear it.
   */
  async setPhotoMark(
    eventId: number,
    photoId: number,
    mark: { rating?: number | null; color_label?: string | null }
  ): Promise<{ rating: number | null; color_label: string | null } | null> {
    const response = await api.put(`/admin/photos/${eventId}/photos/${photoId}/mark`, mark);
    return response.data.mark;
  }

  async getEventPhotos(eventId: number, filters?: PhotoFilters): Promise<AdminPhoto[]> {
    const params = new URLSearchParams();
    
    if (filters) {
      if (filters.category_id !== undefined) {
        params.append('category_id', filters.category_id?.toString() || '');
      }
      if (filters.folder_id !== undefined) params.append('folder_id', String(filters.folder_id));
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
      if (filters.colorLabels && filters.colorLabels.length > 0) {
        params.append('color_label', filters.colorLabels.join(','));
      }
      if (filters.myColorLabels && filters.myColorLabels.length > 0) {
        params.append('my_color_label', filters.myColorLabels.join(','));
      }
      if (filters.decisions && filters.decisions.length > 0) {
        params.append('decision', filters.decisions.join(','));
      }
      if (filters.credit) params.append('credit', filters.credit);
      if (filters.moderation) params.append('moderation', filters.moderation);
      if (filters.logic) params.append('logic', filters.logic);
    }
    
    const queryString = params.toString();
    // Use admin photos router for listing to ensure URL alignment with media/thumbnail endpoints
    const url = `/admin/photos/${eventId}/photos${queryString ? `?${queryString}` : ''}`;
    
    const response = await api.get(url);
    
    // Return photos as-is, URLs are already relative API paths
    return response.data.photos;
  }

  /** How many photos of the event wait for review or were rejected (issue 743). */
  async getModerationCounts(eventId: number): Promise<PhotoModerationCounts> {
    const response = await api.get<{ moderation: PhotoModerationCounts }>(`/admin/photos/${eventId}/photos/moderation`);
    return response.data.moderation;
  }

  /** Publish (approve) or turn down (reject) photos under review; owner only. */
  async moderatePhotos(
    eventId: number,
    photoIds: number[],
    action: 'approve' | 'reject'
  ): Promise<{ updated: number; moderation: PhotoModerationCounts }> {
    const response = await api.post(`/admin/photos/${eventId}/photos/moderation`, { photoIds, action });
    return response.data;
  }

  /** The names on this event's photos with their counts (#1561). */
  async getPhotoCredits(eventId: number): Promise<PhotoCreditSummary> {
    const response = await api.get(`/admin/photos/${eventId}/photos/credits`);
    return response.data;
  }

  /**
   * Correct or clear one photo's credit (#1561). null clears it; either way it
   * becomes a manual credit that no later EXIF read overwrites.
   */
  async setPhotoCredit(
    eventId: number,
    photoId: number,
    creditName: string | null
  ): Promise<{ credit_name: string | null; credit_source: string }> {
    const response = await api.put(`/admin/photos/${eventId}/photos/${photoId}/credit`, { credit_name: creditName });
    return response.data;
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

  /**
   * `skipped_under_review`: photos a visibility change left alone because they
   * wait for review (issue 743); only approving them publishes them.
   */
  async bulkUpdatePhotos(eventId: number, photoIds: number[], updates: Record<string, unknown>): Promise<{ skipped_under_review?: number }> {
    const response = await api.post(`/admin/events/${eventId}/photos/bulk-update`, {
      photoIds,
      updates
    });
    return response.data;
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

  // Chunked upload methods for large files (videos up to 10GB).
  // 10MB chunks stay under Cloudflare Tunnel / free-proxy ~100MB body limits.
  private CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks

  // Default single-request threshold — aligns with Cloudflare-safe batch headroom.
  // Prefer general_max_upload_batch_size_mb from settings when calling from UI.
  private DEFAULT_CHUNKED_THRESHOLD = 95 * 1024 * 1024;

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
        },
        // Large videos: many sequential 10MB parts; avoid client-side abort mid-transfer.
        timeout: 0,
      }
    );
    return response.data;
  }

  async completeChunkedUpload(
    eventId: number,
    uploadId: string,
    categoryId?: number | null,
    folder: FolderPlacement = {}
  ): Promise<{ success: boolean; uploaded: number; photos: AdminPhoto[] }> {
    const response = await api.post(
      `/admin/photos/${eventId}/chunked-upload/${uploadId}/complete`,
      uploadPlacementBody({ ...folder, categoryId }),
      // Merge + ffmpeg thumbnail can take a while on large videos.
      { timeout: 0 }
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
    onProgress?: (progress: number) => void,
    folder: FolderPlacement = {}
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
      const result = await this.completeChunkedUpload(eventId, uploadId, categoryId, folder);
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

  // Check if file should use chunked upload (default > 95MB Cloudflare-safe batch).
  shouldUseChunkedUpload(fileSize: number, thresholdBytes?: number): boolean {
    const threshold = thresholdBytes ?? this.DEFAULT_CHUNKED_THRESHOLD;
    return fileSize > threshold;
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
    if (filters.colorLabels && filters.colorLabels.length > 0) {
      params.append('color_labels', filters.colorLabels.join(','));
    }
    if (filters.myColorLabels && filters.myColorLabels.length > 0) {
      params.append('my_color_labels', filters.myColorLabels.join(','));
    }
    if (filters.decisions && filters.decisions.length > 0) {
      params.append('decisions', filters.decisions.join(','));
    }
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

  // Same endpoint as `exportPhotos` but returns the text content + filename
  // instead of triggering a download. Used by the ExportPreviewModal (#631)
  // for TXT / CSV formats where the admin wants to paste rather than save.
  // XMP (ZIP archive) and JSON keep using exportPhotos — a textarea is the
  // wrong UI for binary archives and structured tool input.
  async exportPhotosAsText(
    eventId: number,
    options: ExportOptions
  ): Promise<{ content: string; filename: string }> {
    const response = await api.post(
      `/admin/photo-export/${eventId}/export`,
      options,
      { responseType: 'blob' }
    );

    const contentDisposition = response.headers['content-disposition'];
    let filename = `export_${Date.now()}`;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
      if (filenameMatch) {
        filename = filenameMatch[1];
      }
    }

    const blob = response.data as Blob;
    const content = await blob.text();
    return { content, filename };
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
  /** Colour labels to keep, e.g. ['green'] (#1044). Empty = no filtering. */
  colorLabels?: string[];
  /** Same, against the caller's own marks. */
  myColorLabels?: string[];
  /** Approve / reject (issue 744). Empty = no filtering. */
  decisions?: DecisionFilter[];
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
  withColorLabels?: number;
  /** Photos per colour (#1044), e.g. { green: 42 }. */
  colorLabelCounts?: Record<string, number>;
  /** Same, for the caller's own marks. */
  myColorLabelCounts?: Record<string, number>;
  /** Photos some guest approved / rejected / either (issue 744). */
  withApproved?: number;
  withRejected?: number;
  withDecisions?: number;
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

/**
 * Wire shape of the export `filter` block. The export endpoint feeds it
 * straight into the backend's PhotoFilterBuilder, which reads snake_case
 * keys — so this is deliberately NOT FeedbackFilters (camelCase, used by
 * the in-app filter UI). Callers convert between the two.
 */
export interface ExportFilter {
  min_rating?: number | null;
  max_rating?: number | null;
  has_likes?: boolean;
  min_likes?: number;
  has_favorites?: boolean;
  min_favorites?: number;
  has_comments?: boolean;
  color_labels?: string[];
  my_color_labels?: string[];
  decisions?: DecisionFilter[];
  category_id?: number;
  logic?: 'AND' | 'OR';
  sort?: 'rating' | 'likes' | 'favorites' | 'date' | 'filename';
  order?: 'asc' | 'desc';
}

export interface ExportOptions {
  photo_ids?: number[];
  filter?: ExportFilter;
  format: 'txt' | 'csv' | 'xmp' | 'json';
  options?: {
    filename_format?: 'original' | 'picpeak';
    separator?: 'newline' | 'comma' | 'semicolon';
    include_extension?: boolean;
    include_rating?: boolean;
    include_label?: boolean;
    include_description?: boolean;
    include_keywords?: boolean;
    /** Whose marks the export reads: the guests' ('client') or the admin's own ('mine'). */
    mark_source?: 'client' | 'mine';
  };
}

export interface ExportFormat {
  value: string;
  label: string;
  description: string;
}

export const photosService = new PhotosService();
