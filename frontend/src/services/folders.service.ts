import { api } from '../config/api';

/**
 * Gallery folders (issue 1786): admin routes under
 * /admin/events/:eventId/folders and /admin/events/:eventId/folder-requests
 * (backend/src/routes/adminFolders.js).
 *
 * A folder is an event-scoped photo_categories row with is_folder set, nested
 * through parent_id, at most max_depth levels deep. A photo's folder is
 * photos.folder_id; category_id holds filter categories only.
 */

export interface GalleryFolder {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  /** Relative path the folder was created from by an upload or import. */
  source_path: string | null;
  hero_photo_id: number | null;
  allow_downloads: boolean;
  display_order?: number | null;
  /** Photos directly in this folder, not counting subfolders. */
  photo_count: number;
}

export type FolderRequestStatus = 'pending' | 'approved' | 'rejected';

/** A folder an upload-only role needed but could not create. */
export interface FolderRequest {
  id: number;
  /** Normalised path, segments joined with '/'. */
  path: string;
  segments: string[];
  /** Where the request's photos wait meanwhile; null = gallery root. */
  fallback_folder_id: number | null;
  requested_by_name: string | null;
  status: FolderRequestStatus;
  created_at: string;
  photo_count: number;
}

export interface FolderTreeResponse {
  folders: GalleryFolder[];
  /** Pending folder requests. */
  requests: FolderRequest[];
  /** The caller holds folders.manage. */
  can_manage: boolean;
  max_depth: number;
}

/** Per level of a resolved path, for the upload preview tree. */
export type FolderNodeStatus = 'exists' | 'new' | 'needs_admin' | 'created' | 'requested';

export type ResolvedDirectoryStatus =
  | 'root'
  | 'exists'
  | 'created'
  | 'new'
  | 'needs_admin'
  | 'requested'
  | 'skipped';

export interface ResolvedDirectory {
  /** Target folder path after skip-outer, keyword and depth folding; null = hidden directory. */
  segments: string[] | null;
  /** The directory sits in a top-level first-look keyword folder (issue 1562). */
  first_look: boolean;
  /** Folder the files land in now (the closest existing one for a request); null = root. */
  folder_id: number | null;
  folder_request_id?: number;
  status: ResolvedDirectoryStatus;
}

export interface ResolveResponse {
  can_manage: boolean;
  /** Name of the one folder everything sits in, when there is one. */
  single_root: string | null;
  max_depth: number;
  /** Keyed by the input path as sent. */
  results: Record<string, ResolvedDirectory>;
  /** Keyed by target path prefix ("Friday", "Friday/Activity A"). */
  nodes: Record<string, FolderNodeStatus>;
  /** Dry run: set when the upload would take the gallery past its folder or open-request limit. */
  limit?: ResolveLimit | null;
}

export interface ResolveLimit {
  code: 'FOLDER_LIMIT_REACHED' | 'FOLDER_REQUEST_LIMIT_REACHED';
  limit: number;
  /** Folders (or open requests) the gallery has now. */
  current: number;
  /** New ones this upload would add. */
  adding: number;
}

export interface ResolveOptions {
  /** Each file's directory relative to what was dropped or picked; '' = the drop root. */
  paths: string[];
  skipOuter: boolean;
  keepStructure: boolean;
  /** Only report (the upload preview); otherwise folders are created or requested. */
  dryRun: boolean;
}

export interface FolderPatch {
  name?: string;
  /** null moves the folder to the top level. */
  parent_id?: number | null;
  allow_downloads?: boolean;
}

/** The backend caps one resolve call at this many distinct paths. */
export const MAX_RESOLVE_PATHS = 500;

/** React Query key of an event's folder tree; mutations invalidate it. */
export const folderQueryKey = (eventId: number) => ['admin-event-folders', eventId] as const;

const base = (eventId: number) => `/admin/events/${eventId}`;

export const foldersService = {
  async list(eventId: number): Promise<FolderTreeResponse> {
    const response = await api.get<FolderTreeResponse>(`${base(eventId)}/folders`);
    return response.data;
  },

  async create(eventId: number, name: string, parentId: number | null): Promise<{ id: number; folders: GalleryFolder[] }> {
    const response = await api.post<{ id: number; folders: GalleryFolder[] }>(`${base(eventId)}/folders`, {
      name,
      parent_id: parentId,
    });
    return response.data;
  },

  async update(eventId: number, folderId: number, patch: FolderPatch): Promise<{ folders: GalleryFolder[] }> {
    const response = await api.patch<{ folders: GalleryFolder[] }>(`${base(eventId)}/folders/${folderId}`, patch);
    return response.data;
  },

  /** Photos and subfolders move up to the parent; no photo is deleted. */
  async remove(eventId: number, folderId: number): Promise<{ moved_photos: number; folders: GalleryFolder[] }> {
    const response = await api.delete<{ moved_photos: number; folders: GalleryFolder[] }>(
      `${base(eventId)}/folders/${folderId}`
    );
    return response.data;
  },

  async resolve(eventId: number, options: ResolveOptions): Promise<ResolveResponse> {
    const response = await api.post<ResolveResponse>(`${base(eventId)}/folders/resolve`, {
      paths: options.paths,
      skip_outer: options.skipOuter,
      keep_structure: options.keepStructure,
      dry_run: options.dryRun,
    });
    return response.data;
  },

  /** Reference-mode events: mirror the external folder tree onto photos not in a folder yet. */
  /** `limited`: the folder limit was reached and some photos went into the closest existing folder. */
  async applyExternalStructure(eventId: number): Promise<{ moved: number; limited: boolean; folders: GalleryFolder[] }> {
    const response = await api.post<{ moved: number; limited: boolean; folders: GalleryFolder[] }>(
      `${base(eventId)}/folders/apply-external-structure`
    );
    return response.data;
  },

  async listRequests(eventId: number): Promise<FolderRequest[]> {
    const response = await api.get<{ requests: FolderRequest[] }>(`${base(eventId)}/folder-requests`);
    return response.data.requests;
  },

  /** `targetFolderId` merges the request into an existing folder instead of creating its path. */
  async approveRequest(
    eventId: number,
    requestId: number,
    targetFolderId: number | null = null
  ): Promise<{ folderId: number; moved: number }> {
    const response = await api.post<{ folderId: number; moved: number }>(
      `${base(eventId)}/folder-requests/${requestId}/approve`,
      targetFolderId ? { target_folder_id: targetFolderId } : {}
    );
    return response.data;
  },

  async rejectRequest(eventId: number, requestId: number): Promise<void> {
    await api.post(`${base(eventId)}/folder-requests/${requestId}/reject`);
  },
};
