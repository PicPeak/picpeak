/**
 * Admin → customer documents API client (#1444).
 *
 * Hits /api/admin/customers/:id/documents/*. Every endpoint needs the
 * `documents` feature flag and `customers.documents.manage`.
 */
import { api } from '../config/api';

export type AdminCustomerDocumentStatus = 'pending' | 'clean' | 'rejected';

export interface AdminCustomerDocument {
  id: number;
  name: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  uploaderType: 'admin' | 'customer';
  uploaderName: string | null;
  status: AdminCustomerDocumentStatus;
  reviewedAt: string | null;
  reviewNote: string | null;
  shared: boolean;
  sharedAt: string | null;
  unsharedAt: string | null;
  eventId: number | null;
  eventName: string | null;
  projectId: number | null;
  contractId: number | null;
  contractNumber: string | null;
  createdAt: string | null;
  customerViewCount: number;
  customerFirstViewedAt: string | null;
  customerLastViewedAt: string | null;
}

export interface AdminCustomerDocumentLimits {
  maxUploadBytes: number;
  quotaBytes: number;
  /** Bytes of the customer's own (non-deleted) uploads. */
  usedBytes: number;
}

/** What happened to the mail a share would send: see customerDocumentNotifications. */
export type DocumentNotification = 'queued' | 'skipped' | 'failed';

export interface DocumentLinks {
  eventId: number | null;
  projectId?: number | null;
  contractId: number | null;
}

const base = (customerId: number) => `/admin/customers/${customerId}/documents`;

export const customerDocumentsAdminService = {
  async list(customerId: number): Promise<{
    documents: AdminCustomerDocument[];
    limits: AdminCustomerDocumentLimits;
    settings?: { notifyOnShare: boolean };
  }> {
    const { data } = await api.get(base(customerId));
    return data;
  },

  async upload(
    customerId: number,
    file: File,
    options: { share: boolean; notify?: boolean; eventId?: number | null; projectId?: number | null },
  ): Promise<{ notification?: DocumentNotification }> {
    const form = new FormData();
    form.append('file', file);
    form.append('share', options.share ? 'true' : 'false');
    if (options.notify !== undefined) form.append('notify', options.notify ? 'true' : 'false');
    if (options.eventId) form.append('eventId', String(options.eventId));
    if (options.projectId) form.append('projectId', String(options.projectId));
    const { data } = await api.post(base(customerId), form);
    return { notification: data?.notification };
  },

  async setLinks(customerId: number, documentId: number, links: DocumentLinks): Promise<void> {
    await api.patch(`${base(customerId)}/${documentId}`, links);
  },

  async share(customerId: number, documentId: number, notify?: boolean): Promise<DocumentNotification | undefined> {
    const { data } = await api.post(`${base(customerId)}/${documentId}/share`, notify === undefined ? {} : { notify });
    return data?.notification;
  },

  async unshare(customerId: number, documentId: number): Promise<void> {
    await api.post(`${base(customerId)}/${documentId}/unshare`);
  },

  async review(
    customerId: number, documentId: number, status: 'clean' | 'rejected', note?: string,
  ): Promise<DocumentNotification | undefined> {
    const { data } = await api.post(`${base(customerId)}/${documentId}/review`, { status, note: note || null });
    return data?.notification;
  },

  async remove(customerId: number, documentId: number): Promise<void> {
    await api.delete(`${base(customerId)}/${documentId}`);
  },

  /** Download as an attachment — the file may come from the customer and is never opened inline. */
  async download(customerId: number, doc: Pick<AdminCustomerDocument, 'id' | 'name'>): Promise<void> {
    const res = await api.get(`${base(customerId)}/${doc.id}/download`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
