/**
 * Transfers API client (PicTransfer, #997).
 *
 * Three surfaces share one file:
 *   - Admin CRUD under /admin/transfers/* (cookie auth).
 *   - Public recipient download under /public/transfer/:token (token in URL).
 *   - Public client upload under /public/transfer-upload/:token (10-char code).
 */
import { api } from '../config/api';
import { getApiBaseUrl } from '../utils/url';
import { planTransferFiles } from '../utils/uploadBatches';
import { uploadFileInChunks } from './guestChunkedUpload';

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

export interface Transfer {
  id: number;
  token: string;
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
  download_url: string;
  upload_url: string | null;
  file_count: number;
  upload_count: number;
  files?: TransferFile[];
  extra_files?: TransferExtraFile[];
  recipients?: TransferRecipient[];
  uploads?: TransferUpload[];
}

export interface CreateTransferInput {
  title?: string;
  message?: string | null;
  expiresInDays?: number;
  maxDownloads?: number | null;
  graceDays?: number;
  allowUploads?: boolean;
  uploadExpiresInDays?: number;
  photoIds?: number[];
  /** 'link' (default) or 'email' — email the download link to recipientEmails. */
  deliveryMethod?: 'link' | 'email';
  recipientEmails?: string[];
  /** The operator's own files to include in the transfer as deliverables. */
  files?: File[];
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
  /** Raw body budget of one upload request, in bytes. */
  max_request_bytes: number;
  allowed_mime: string[];
}

/**
 * A transfer plus what a write too large for one request did not land: the
 * transfer exists without `failed_files`, and with `delivery_held` its email
 * was not sent.
 */
export interface TransferWriteResult extends Transfer {
  failed_files?: string[];
  delivery_held?: boolean;
  /** The email went out, but not to every recipient; it is not sent again. */
  delivery_partial?: boolean;
}

/** The most files one admin multipart request carries (ADMIN_MAX_FILES in adminTransfers.js). */
const ADMIN_MAX_FILES_PER_REQUEST = 50;

/** Overall percentage over several requests, from the bytes each has sent. */
function byteProgress(files: File[], onProgress?: (pct: number) => void) {
  const total = files.reduce((sum, f) => sum + f.size, 0) || 1;
  let done = 0;
  return {
    /** Report `sent` bytes of the request in flight on top of the finished ones. */
    report(sent: number) {
      onProgress?.(Math.min(100, Math.round(((done + sent) / total) * 100)));
    },
    /** A request settled (landed or not): its bytes count as handled. */
    finish(bytes: number) {
      done += bytes;
      this.report(0);
    },
  };
}

const sizeOf = (files: File[]) => files.reduce((sum, f) => sum + f.size, 0);

/**
 * Upload `files` into an existing send after the first request: further
 * multipart batches, then each large file in chunks. Nothing here throws; a
 * file that does not land is named in `failed` and the rest go on.
 */
async function uploadRemaining(
  id: number,
  batches: File[][],
  chunked: File[],
  progress: ReturnType<typeof byteProgress>,
): Promise<{ failed: string[]; firstError: unknown; last: Transfer | null }> {
  const failed: string[] = [];
  let firstError: unknown = null;
  // The transfer as the last write that landed answered it.
  let last: Transfer | null = null;
  const refused = (files: File[], error: unknown) => {
    firstError = firstError ?? error;
    failed.push(...files.map((f) => f.name));
  };
  for (const batch of batches) {
    const form = new FormData();
    batch.forEach((f) => form.append('files', f));
    try {
      const res = await api.post(`/admin/transfers/${id}/upload-files`, form, {
        onUploadProgress: (e) => progress.report(e.total ? (sizeOf(batch) * e.loaded) / e.total : 0),
      });
      // Accepted but not stored: not uploaded, whatever the 200 says.
      failed.push(...(res.data.failed_files || []));
      last = res.data.transfer ?? last;
    } catch (error) {
      refused(batch, error);
    }
    progress.finish(sizeOf(batch));
  }
  for (const file of chunked) {
    try {
      const res = await uploadFileInChunks<{ transfer?: Transfer }>(`/admin/transfers/${id}`, file, {
        initFields: { mimeType: file.type },
        onBytes: (sent) => progress.report(sent),
      });
      last = res.data.transfer ?? last;
    } catch (error) {
      refused([file], error);
    }
    progress.finish(file.size);
  }
  return { failed, firstError, last };
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
    // multipart: the operator's own files ride along with the form fields —
    // all of them when they fit one request. Otherwise the first batch does,
    // and the rest follow into the new transfer (see createWithLargeFiles).
    const files = input.files || [];
    const plan = planTransferFiles(files, ADMIN_MAX_FILES_PER_REQUEST);
    if (plan.chunked.length > 0 || plan.batches.length > 1) {
      return transfersService.createWithLargeFiles(input, plan, onProgress);
    }
    const form = new FormData();
    if (input.title != null) form.append('title', input.title);
    if (input.message != null) form.append('message', input.message);
    if (input.expiresInDays != null) form.append('expiresInDays', String(input.expiresInDays));
    if (input.maxDownloads != null) form.append('maxDownloads', String(input.maxDownloads));
    if (input.graceDays != null) form.append('graceDays', String(input.graceDays));
    form.append('allowUploads', String(!!input.allowUploads));
    if (input.uploadExpiresInDays != null) form.append('uploadExpiresInDays', String(input.uploadExpiresInDays));
    form.append('photoIds', JSON.stringify(input.photoIds || []));
    form.append('deliveryMethod', input.deliveryMethod || 'link');
    form.append('recipientEmails', JSON.stringify(input.recipientEmails || []));
    files.forEach((f) => form.append('files', f));
    const res = await api.post('/admin/transfers', form, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return { ...res.data.transfer, failed_files: res.data.failed_files || [] };
  },
  /**
   * A transfer whose files do not fit one request. It is created with the
   * first batch and told how many files are still coming (`pendingFiles`), so
   * its email is not sent yet. The rest follow in further requests and chunks;
   * only when every one has landed is the email sent (POST /:id/deliver, once).
   * A file that fails leaves the transfer without it and the email unsent,
   * and both are reported back.
   */
  async createWithLargeFiles(
    input: CreateTransferInput,
    plan: { batches: File[][]; chunked: File[] },
    onProgress?: (pct: number) => void,
  ): Promise<TransferWriteResult> {
    const files = input.files || [];
    const [first = [], ...rest] = plan.batches;
    const progress = byteProgress(files, onProgress);
    const form = new FormData();
    if (input.title != null) form.append('title', input.title);
    if (input.message != null) form.append('message', input.message);
    if (input.expiresInDays != null) form.append('expiresInDays', String(input.expiresInDays));
    if (input.maxDownloads != null) form.append('maxDownloads', String(input.maxDownloads));
    if (input.graceDays != null) form.append('graceDays', String(input.graceDays));
    form.append('allowUploads', String(!!input.allowUploads));
    if (input.uploadExpiresInDays != null) form.append('uploadExpiresInDays', String(input.uploadExpiresInDays));
    form.append('photoIds', JSON.stringify(input.photoIds || []));
    form.append('deliveryMethod', input.deliveryMethod || 'link');
    form.append('recipientEmails', JSON.stringify(input.recipientEmails || []));
    form.append('pendingFiles', String(files.length - first.length));
    first.forEach((f) => form.append('files', f));
    const res = await api.post('/admin/transfers', form, {
      onUploadProgress: (e) => progress.report(e.total ? (sizeOf(first) * e.loaded) / e.total : 0),
    });
    progress.finish(sizeOf(first));
    const created: Transfer = res.data.transfer;

    const remaining = await uploadRemaining(created.id, rest, plan.chunked, progress);
    // Files of the create request that did not land count as failed too.
    const failed = [...(res.data.failed_files || []), ...remaining.failed];
    // The list the create kept (trimmed, at most 100) and the server would
    // mail: deliver validates each address and refuses more than 100, so the
    // raw list could fail it after every file had been uploaded.
    const recipients = [...new Set((input.recipientEmails || [])
      .map((e) => String(e || '').trim())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 100);
    let deliveryHeld = false;
    let deliveryPartial = false;
    if (input.deliveryMethod === 'email' && recipients.length) {
      if (failed.length) deliveryHeld = true;
      else {
        await api.post(`/admin/transfers/${created.id}/deliver`, { recipientEmails: recipients })
          .then((res) => { deliveryPartial = res?.data?.partial === true; })
          .catch(() => { deliveryHeld = true; });
      }
    }
    // The transfer exists now: a failed refresh must not turn that into an
    // error (the dialog would stay open and a retry create a second one).
    const fresh = await transfersService.get(created.id).catch(() => null);
    return { ...(fresh || created), failed_files: failed, delivery_held: deliveryHeld, delivery_partial: deliveryPartial };
  },
  /**
   * Add deliverable files to an existing transfer: in one request when they
   * fit, otherwise in several and large files in chunks. Throws only when no
   * file landed; otherwise the ones that did not are in `failed_files`.
   */
  async uploadFiles(id: number, files: File[], onProgress?: (pct: number) => void): Promise<TransferWriteResult> {
    const plan = planTransferFiles(files, ADMIN_MAX_FILES_PER_REQUEST);
    if (plan.chunked.length > 0 || plan.batches.length > 1) {
      const { failed, firstError, last } = await uploadRemaining(id, plan.batches, plan.chunked, byteProgress(files, onProgress));
      if (firstError && failed.length === files.length) throw firstError;
      // Files are stored now: a failed refresh must not turn that into an
      // error (a retry would store them twice). Fall back to the last answer.
      const fresh = await transfersService.get(id).catch((error) => {
        if (!last) throw error;
        return last;
      });
      return { ...fresh, failed_files: failed };
    }
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    const res = await api.post(`/admin/transfers/${id}/upload-files`, form, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return { ...res.data.transfer, failed_files: res.data.failed_files || [] };
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
  async enableUploads(id: number, uploadExpiresInDays?: number): Promise<Transfer> {
    const res = await api.post(`/admin/transfers/${id}/upload-link`, { uploadExpiresInDays });
    return res.data.transfer;
  },
  async disableUploads(id: number): Promise<Transfer> {
    const res = await api.delete(`/admin/transfers/${id}/upload-link`);
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
  /** One file too large for an upload request, sent in chunks. Answers like `upload`. */
  async uploadChunked(token: string, file: File, onProgress?: (pct: number) => void): Promise<{ uploaded: number }> {
    const res = await uploadFileInChunks<{ uploaded: number }>(`/public/transfer-upload/${token}`, file, {
      initFields: { mimeType: file.type },
      onBytes: (sent) => onProgress?.(file.size ? Math.round((sent / file.size) * 100) : 100),
    });
    return res.data;
  },
  async upload(token: string, files: File[], onProgress?: (pct: number) => void): Promise<{ uploaded: number }> {
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
