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
  /** The ready email waits until the transfer has a finished photo. */
  held: boolean;
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
  /** Requests only — this request's own files-per-upload limit, null when it follows the default. */
  max_files_per_upload?: number | null;
  /** Requests only, detail view — the limit in force, own or default. */
  effective_max_files_per_upload?: number | null;
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
  /** Requests only — own files-per-upload limit; leave out to use the default. */
  maxFilesPerUpload?: number | null;
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
  /**
   * Files that did not land at all: a later request or chunked upload of a
   * write too large for one request failed. The transfer exists without them.
   */
  failed_files?: string[];
  /** The ready email was not sent because files failed; the recipients are held. */
  delivery_held?: boolean;
}

export interface UpdateTransferInput {
  title?: string;
  message?: string | null;
  maxDownloads?: number | null;
  graceDays?: number;
  expiresInDays?: number;
  expiresAt?: string;
  isActive?: boolean;
  /** Requests only — null hands the limit back to the global default. */
  maxFilesPerUpload?: number | null;
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

function errorCode(error: unknown): { code?: string; rejected?: string[] } {
  const data = (error as { response?: { data?: { code?: string; rejected_files?: string[] } } })?.response?.data;
  return { code: data?.code, rejected: data?.rejected_files };
}

/**
 * Upload `files` into an existing send after the first request: further
 * multipart batches, then each large file in chunks. Nothing here throws; a
 * file that does not land is named in `failed` (or `rejected`, refused on
 * type) and the rest go on. A new send's ready mail is held server-side
 * until the caller sends it (the resend route).
 */
async function uploadRemaining(
  id: number,
  batches: File[][],
  chunked: File[],
  progress: ReturnType<typeof byteProgress>,
): Promise<{ rejected: string[]; failed: string[]; firstError: unknown; last: Transfer | null }> {
  const rejected: string[] = [];
  const failed: string[] = [];
  let firstError: unknown = null;
  // The transfer as the last write that landed answered it.
  let last: Transfer | null = null;
  const refused = (files: File[], error: unknown) => {
    firstError = firstError ?? error;
    const { code, rejected: names } = errorCode(error);
    if (code === 'TYPE_REJECTED' && names?.length) rejected.push(...names);
    else failed.push(...files.map((f) => f.name));
  };
  for (const batch of batches) {
    const form = new FormData();
    batch.forEach((f) => form.append('files', f));
    try {
      const res = await api.post(`/admin/transfers/${id}/upload-files`, form, {
        onUploadProgress: (e) => progress.report(e.total ? (sizeOf(batch) * e.loaded) / e.total : 0),
      });
      rejected.push(...(res.data.rejected_files || []));
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
  return { rejected, failed, firstError, last };
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
  /** The global files-per-upload default and the largest value a request may carry. */
  async uploadDefaults(): Promise<{ max_files_per_upload: number; max_files_ceiling: number }> {
    const res = await api.get('/admin/transfers/upload-defaults');
    return { max_files_per_upload: res.data.max_files_per_upload, max_files_ceiling: res.data.max_files_ceiling };
  },
  async get(id: number): Promise<Transfer> {
    const res = await api.get(`/admin/transfers/${id}`);
    return res.data.transfer;
  },
  async create(input: CreateTransferInput, onProgress?: (pct: number) => void): Promise<TransferWriteResult> {
    // multipart: the operator's own files ride along with the form fields —
    // all of them when they fit one request. Otherwise the first batch does,
    // and the rest follow into the new send (see createWithLargeFiles).
    const files = input.files || [];
    const plan = planTransferFiles(files, ADMIN_MAX_FILES_PER_REQUEST);
    if (input.kind !== 'request' && (plan.chunked.length > 0 || plan.batches.length > 1)) {
      return transfersService.createWithLargeFiles(input, plan, onProgress);
    }
    const form = new FormData();
    if (input.title != null) form.append('title', input.title);
    if (input.message != null) form.append('message', input.message);
    if (input.expiresInDays != null) form.append('expiresInDays', String(input.expiresInDays));
    if (input.maxDownloads != null) form.append('maxDownloads', String(input.maxDownloads));
    if (input.graceDays != null) form.append('graceDays', String(input.graceDays));
    if (input.maxFilesPerUpload != null) form.append('maxFilesPerUpload', String(input.maxFilesPerUpload));
    form.append('kind', input.kind || 'send');
    form.append('photoIds', JSON.stringify(input.photoIds || []));
    form.append('deliveryMethod', input.deliveryMethod || 'link');
    form.append('recipientEmails', JSON.stringify(input.recipientEmails || []));
    files.forEach((f) => form.append('files', f));
    const res = await api.post('/admin/transfers', form, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return withWriteNotes(res.data);
  },
  /**
   * A send whose files do not fit one request. The send is created with the
   * first batch and told how many files are still coming (`pendingFiles`), so
   * it is not refused as empty and its ready mail is held rather than sent.
   * The rest follow in further requests and chunks; only when every one has
   * landed is the mail sent (the resend route). A file that fails leaves the
   * send without it and the mail held, and both are reported back.
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
    form.append('kind', 'send');
    form.append('photoIds', JSON.stringify(input.photoIds || []));
    form.append('deliveryMethod', input.deliveryMethod || 'link');
    form.append('recipientEmails', JSON.stringify(input.recipientEmails || []));
    form.append('pendingFiles', String(files.length - first.length));
    first.forEach((f) => form.append('files', f));
    const res = await api.post('/admin/transfers', form, {
      onUploadProgress: (e) => progress.report(e.total ? (sizeOf(first) * e.loaded) / e.total : 0),
    });
    progress.finish(sizeOf(first));
    const created = withWriteNotes(res.data);

    const mailing = input.deliveryMethod === 'email' && (input.recipientEmails || []).length > 0;
    const { rejected, failed } = await uploadRemaining(created.id, rest, plan.chunked, progress);
    let deliveryHeld = false;
    if (mailing) {
      if (failed.length) deliveryHeld = true;
      else await transfersService.resendEmail(created.id).catch(() => { deliveryHeld = true; });
    }
    // The send exists now: a failed refresh must not turn that into an error
    // (the dialog would stay open and a retry create a second send).
    const fresh = await transfersService.get(created.id).catch(() => null);
    return {
      ...(fresh || created),
      rejected_files: [...(created.rejected_files || []), ...rejected],
      dropped_files: created.dropped_files || [],
      failed_files: failed,
      delivery_held: deliveryHeld,
    };
  },
  /**
   * Add deliverable files to an existing transfer: in one request when they
   * fit, otherwise in several and large files in chunks. Throws only when no
   * file landed; otherwise the ones that did not are in `failed_files`.
   */
  async uploadFiles(id: number, files: File[], onProgress?: (pct: number) => void): Promise<TransferWriteResult> {
    const plan = planTransferFiles(files, ADMIN_MAX_FILES_PER_REQUEST);
    if (plan.chunked.length > 0 || plan.batches.length > 1) {
      const { rejected, failed, firstError, last } = await uploadRemaining(
        id, plan.batches, plan.chunked, byteProgress(files, onProgress),
      );
      if (firstError && rejected.length + failed.length === files.length) throw firstError;
      // Files are stored now: a failed refresh must not turn that into an
      // error (a retry would store them twice). Fall back to the last answer.
      const fresh = await transfersService.get(id).catch((error) => {
        if (!last) throw error;
        return last;
      });
      return { ...fresh, rejected_files: rejected, failed_files: failed };
    }
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
  async resendEmail(id: number, recipientEmails?: string[]): Promise<{ transfer: Transfer; held: boolean }> {
    const res = await api.post(`/admin/transfers/${id}/resend`, { recipientEmails });
    return { transfer: res.data.transfer, held: res.data.held === true };
  },
  /** Absolute API URL for the admin ZIP download (cookie auth → usable as href). */
  adminDownloadUrl(id: number): string {
    return `${getApiBaseUrl()}/admin/transfers/${id}/download`;
  },
  /** Everything a client sent through a file request, as one ZIP. */
  adminUploadsDownloadUrl(id: number): string {
    return `${getApiBaseUrl()}/admin/transfers/${id}/uploads/download`;
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
  /**
   * One file too large for an upload request, sent in chunks. Answers like
   * `upload`; a refusal throws, as `upload` does.
   */
  async uploadChunked(token: string, file: File, onProgress?: (pct: number) => void): Promise<UploadResult> {
    const res = await uploadFileInChunks<UploadResult>(`/public/transfer-upload/${token}`, file, {
      initFields: { mimeType: file.type },
      onBytes: (sent) => onProgress?.(file.size ? Math.round((sent / file.size) * 100) : 100),
    });
    return res.data;
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
