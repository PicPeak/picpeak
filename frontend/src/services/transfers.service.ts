/**
 * Transfers API client (PicTransfer, #997).
 *
 * Three surfaces share one file:
 *   - Admin CRUD under /admin/transfers/* (cookie auth).
 *   - Public recipient download under /public/transfer/:token (token in URL).
 *   - Public client upload under /public/transfer-upload/:token.
 *
 * Since #1544 a transfer is a send OR a request (`kind`), never both. A send
 * has a download_url; a request has an upload_url on its 64-hex token plus an
 * optional short read-aloud code.
 */
import { api } from '../config/api';
import { getApiBaseUrl } from '../utils/url';

export interface TransferFile {
  file_id: number;
  photo_id: number;
  filename: string;
  type: string;
  size_bytes: number | null;
  event_id: number;
  event_name: string;
  event_slug: string;
  thumbnail_url: string;
}

export interface TransferUpload {
  id: number;
  original_filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  uploader_ip: string | null;
  uploaded_at: string;
}

/** An admin-uploaded deliverable file (not a referenced gallery photo). */
export interface TransferExtraFile {
  id: number;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
}

export interface TransferRecipient {
  id: number;
  email: string;
  last_sent_at: string | null;
}

export type TransferKind = 'send' | 'request';

export interface Transfer {
  id: number;
  token: string;
  kind: TransferKind;
  title: string;
  message: string | null;
  expires_at: string;
  max_downloads: number | null;
  download_count: number;
  downloads_remaining: number | null;
  is_active: boolean;
  disabled_at: string | null;
  grace_days: number;
  deleted_at: string | null;
  allow_uploads: boolean;
  delivery_method: 'link' | 'email';
  upload_token: string | null;
  upload_expires_at: string | null;
  created_at: string;
  updated_at: string;
  status: 'active' | 'expired' | 'deleted';
  /** Sends only. */
  download_url: string | null;
  /** Requests only — the primary 64-hex link. */
  upload_url: string | null;
  /** Requests only — the optional short read-aloud code, if one is issued. */
  upload_code: string | null;
  upload_code_url: string | null;
  file_count: number;
  upload_count: number;
  files?: TransferFile[];
  extra_files?: TransferExtraFile[];
  recipients?: TransferRecipient[];
  uploads?: TransferUpload[];
}

export interface CreateTransferInput {
  /** 'send' (default) or 'request'. Decides the whole shape of the row. */
  kind?: TransferKind;
  title?: string;
  message?: string | null;
  expiresInDays?: number;
  maxDownloads?: number | null;
  graceDays?: number;
  /** Sends only — a request carries no outbound photos. */
  photoIds?: number[];
  /** 'link' (default) or 'email' — email the link to recipientEmails. */
  deliveryMethod?: 'link' | 'email';
  recipientEmails?: string[];
  /** Sends only — the operator's own files to include as deliverables. */
  files?: File[];
}

/**
 * A transfer plus what the write did NOT keep.
 *
 * The routes answer `{ transfer, rejected_files, dropped_files }`; returning
 * `res.data.transfer` alone silently threw both lists away, so the admin was
 * never told which files were skipped.
 */
export interface TransferWriteResult extends Transfer {
  /** Files the server refused on type. */
  rejected_files?: string[];
  /** Files it accepted but did not keep (attached to a request, which sends nothing). */
  dropped_files?: string[];
}

export interface UpdateTransferInput {
  title?: string;
  message?: string | null;
  maxDownloads?: number | null;
  graceDays?: number;
  expiresInDays?: number;
  expiresAt?: string;
  isActive?: boolean;
}

// --- Public shapes ---

export interface PublicTransferFile {
  // Prefixed on the server: `p<id>` = gallery photo, `x<id>` = uploaded file.
  file_id: string;
  filename: string;
  size_bytes: number | null;
}

export interface PublicTransferView {
  title: string;
  message?: string | null;
  status: 'active' | 'expired' | 'limit_reached';
  downloadable: boolean;
  expires_at: string;
  file_count?: number;
  total_bytes?: number;
  downloads_remaining?: number | null;
  files?: PublicTransferFile[];
}

export interface UploadInfo {
  title: string;
  message: string | null;
  expires_at: string;
  max_size_mb: number;
  max_files: number;
  /** When true the server skips the type check entirely. */
  accept_all: boolean;
  allowed_mime: string[];
  /** Lower-cased, dot-prefixed — what the page filters and labels with. */
  allowed_extensions: string[];
}

/** What an upload actually did — not every file necessarily landed. */
export interface UploadResult {
  uploaded: number;
  files: { filename: string; size_bytes: number }[];
  /** Refused on type before any bytes were stored. */
  rejected_files: string[];
  /** Accepted, but the bytes or the row did not land. These are NOT uploaded. */
  failed_files: string[];
}

/** Lift the sibling `rejected_files` / `dropped_files` onto the transfer. */
function withWriteNotes(data: {
  transfer: Transfer;
  rejected_files?: string[];
  dropped_files?: string[];
}): TransferWriteResult {
  return {
    ...data.transfer,
    rejected_files: data.rejected_files || [],
    dropped_files: data.dropped_files || [],
  };
}

export const transfersService = {
  // --- Admin ---
  async list(search = ''): Promise<Transfer[]> {
    const res = await api.get('/admin/transfers', { params: search ? { q: search } : {} });
    return res.data.transfers;
  },
  async get(id: number): Promise<Transfer> {
    const res = await api.get(`/admin/transfers/${id}`);
    return res.data.transfer;
  },
  async create(input: CreateTransferInput, onProgress?: (pct: number) => void): Promise<TransferWriteResult> {
    // multipart: the operator's own files ride along with the form fields.
    const form = new FormData();
    if (input.title != null) form.append('title', input.title);
    if (input.message != null) form.append('message', input.message);
    if (input.expiresInDays != null) form.append('expiresInDays', String(input.expiresInDays));
    if (input.maxDownloads != null) form.append('maxDownloads', String(input.maxDownloads));
    if (input.graceDays != null) form.append('graceDays', String(input.graceDays));
    form.append('kind', input.kind || 'send');
    form.append('photoIds', JSON.stringify(input.photoIds || []));
    form.append('deliveryMethod', input.deliveryMethod || 'link');
    form.append('recipientEmails', JSON.stringify(input.recipientEmails || []));
    (input.files || []).forEach((f) => form.append('files', f));
    const res = await api.post('/admin/transfers', form, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return withWriteNotes(res.data);
  },
  /** Add deliverable files to an existing transfer. */
  async uploadFiles(id: number, files: File[], onProgress?: (pct: number) => void): Promise<TransferWriteResult> {
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    const res = await api.post(`/admin/transfers/${id}/upload-files`, form, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return withWriteNotes(res.data);
  },
  async removeExtraFile(id: number, extraId: number): Promise<Transfer> {
    const res = await api.delete(`/admin/transfers/${id}/extra-files/${extraId}`);
    return res.data.transfer;
  },
  adminExtraFileDownloadUrl(id: number, extraId: number): string {
    return `${getApiBaseUrl()}/admin/transfers/${id}/extra-files/${extraId}/download`;
  },
  async update(id: number, input: UpdateTransferInput): Promise<Transfer> {
    const res = await api.patch(`/admin/transfers/${id}`, input);
    return res.data.transfer;
  },
  async remove(id: number): Promise<void> {
    await api.delete(`/admin/transfers/${id}`);
  },
  async addFiles(id: number, photoIds: number[]): Promise<Transfer> {
    const res = await api.post(`/admin/transfers/${id}/files`, { photoIds });
    return res.data.transfer;
  },
  async removeFile(id: number, fileId: number): Promise<Transfer> {
    const res = await api.delete(`/admin/transfers/${id}/files/${fileId}`);
    return res.data.transfer;
  },
  /** Issue (or, with rotate, replace) a request's short read-aloud upload code. */
  async issueUploadCode(id: number, rotate = false): Promise<Transfer> {
    const res = await api.post(`/admin/transfers/${id}/upload-code`, { rotate });
    return res.data.transfer;
  },
  /** Withdraw the short code. The request stays open on its 64-hex link. */
  async revokeUploadCode(id: number): Promise<Transfer> {
    const res = await api.delete(`/admin/transfers/${id}/upload-code`);
    return res.data.transfer;
  },
  /** Re-send the delivery/request email to the addresses already on the row. */
  async resendEmail(id: number, recipientEmails?: string[]): Promise<Transfer> {
    const res = await api.post(`/admin/transfers/${id}/resend`, { recipientEmails });
    return res.data.transfer;
  },
  /** Absolute API URL for the admin ZIP download (cookie auth → usable as href). */
  adminDownloadUrl(id: number): string {
    return `${getApiBaseUrl()}/admin/transfers/${id}/download`;
  },
  adminUploadDownloadUrl(id: number, uploadId: number): string {
    return `${getApiBaseUrl()}/admin/transfers/${id}/uploads/${uploadId}/download`;
  },

  // --- Public recipient ---
  async getPublic(token: string): Promise<PublicTransferView> {
    const res = await api.get(`/public/transfer/${token}`);
    return res.data.transfer;
  },
  publicDownloadAllUrl(token: string): string {
    return `${getApiBaseUrl()}/public/transfer/${token}/download`;
  },
  publicFileUrl(token: string, fileId: string): string {
    return `${getApiBaseUrl()}/public/transfer/${token}/download/${fileId}`;
  },

  // --- Public client upload ---
  async getUploadInfo(token: string): Promise<UploadInfo> {
    const res = await api.get(`/public/transfer-upload/${token}`);
    return res.data.transfer;
  },
  async upload(token: string, files: File[], onProgress?: (pct: number) => void): Promise<UploadResult> {
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    const res = await api.post(`/public/transfer-upload/${token}`, form, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return res.data;
  },
};
