/**
 * Admin → document attachments (#1445). Hits /api/admin/document-attachments/*.
 * A library of PDFs (terms, privacy notices, appendices) that contract
 * templates and contracts include — merged into the contract PDF before the
 * signature page, or sent as a separate file.
 */
import { api } from '../config/api';

export type AttachmentDelivery = 'merged' | 'separate';

export interface DocumentAttachment {
  id: number;
  name: string;
  description: string | null;
  originalName: string | null;
  sha256: string;
  bytes: number;
  pages: number;
  isActive: boolean;
  createdAt: string;
}

/** An attachment on a template version or a contract, in delivery order. */
export interface IncludedAttachment {
  attachmentId: number;
  position: number;
  delivery: AttachmentDelivery;
  name: string;
  pages: number;
  bytes: number;
  sha256: string;
  isActive: boolean;
}

export interface AttachmentSelection {
  attachmentId: number;
  delivery: AttachmentDelivery;
}

/** The upload cap (backend MAX_BYTES). */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const base = '/admin/document-attachments';
const unwrap = <T>(data: { data?: T } & T): T => (data.data || data) as T;

export const documentAttachmentsService = {
  async list(): Promise<{ attachments: DocumentAttachment[] }> {
    const { data } = await api.get(base);
    return unwrap(data);
  },
  /** `existing` when the same file was already in the library. */
  async upload(file: File, meta: { name?: string; description?: string }): Promise<{ attachment: DocumentAttachment; existing: boolean }> {
    const form = new FormData();
    form.append('file', file);
    if (meta.name) form.append('name', meta.name);
    if (meta.description) form.append('description', meta.description);
    const { data } = await api.post(base, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    return unwrap(data);
  },
  async archive(id: number): Promise<{ attachment: DocumentAttachment }> {
    const { data } = await api.post(`${base}/${id}/archive`);
    return unwrap(data);
  },
  async restore(id: number): Promise<{ attachment: DocumentAttachment }> {
    const { data } = await api.post(`${base}/${id}/restore`);
    return unwrap(data);
  },
  /** The stored file, as an object URL. */
  async downloadUrl(id: number): Promise<string> {
    const res = await api.get(`${base}/${id}/download`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },
};

/** "1.2 MB" / "340 KB" */
export function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
