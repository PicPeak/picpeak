/**
 * Customer portal → Documents (#1444).
 *
 * Documents the photographer shared, plus the customer's own uploads. Which
 * file types can be uploaded comes from the server (`allowedFormats`). An upload
 * stays "Awaiting review" until the studio has checked it; only available
 * documents can be downloaded, and always as a file, never opened in the
 * browser. The upload shows progress, can be cancelled, keeps the file
 * selected on failure so it can be retried, and announces the server's
 * answer through a live region.
 */
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, FolderOpen, Inbox, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Loading, useConfirm } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { formatFileSize } from '../../utils/fileSize';
import {
  acceptFor, allowedFormatOf, formatList, normaliseFormats,
} from '../../utils/documentFormats';
import { customerService, type CustomerDocument } from '../../services/customer.service';

/** Error code from an API error. Blob responses (downloads) carry JSON too. */
export async function readErrorCode(err: any): Promise<string | undefined> {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text())?.code; } catch { return undefined; }
  }
  return data?.code;
}

export function uploadErrorMessage(
  t: TFunction, code: string | undefined, name: string, maxBytes?: number, formats = 'PDF',
): string {
  switch (code) {
    case 'FORMAT_NOT_ALLOWED':
      return t('customer.documents.errors.formatNotAllowed', '{{name}} is not a file type you can upload here. Accepted: {{formats}}.', { name, formats });
    case 'NOT_A_PDF':
      return t('customer.documents.errors.notPdf', '{{name}} is not a PDF. Only PDF documents can be uploaded.', { name });
    case 'DOCUMENT_NOT_VALID':
      return t('customer.documents.errors.notValid', '{{name}} is not a valid file of its type. Save it again from the program that made it and upload that file.', { name });
    case 'DOCUMENT_ACTIVE_CONTENT':
      return t('customer.documents.errors.officeActiveContent',
        '{{name}} contains macros, embedded code or links to outside content and cannot be uploaded. Save it as PDF and upload that file.', { name });
    case 'DOCUMENT_ENCRYPTED':
      return t('customer.documents.errors.documentEncrypted', '{{name}} is password-protected. Remove the password and upload it again.', { name });
    case 'DOCUMENT_TOO_COMPLEX':
      return t('customer.documents.errors.documentTooComplex', '{{name}} could not be checked. Save it as PDF and upload that file.', { name });
    case 'DOCUMENT_CHECK_UNAVAILABLE':
      return t('customer.documents.errors.checkUnavailable', '{{name}} cannot be checked right now. Please try again later.', { name });
    case 'DOCUMENT_NOT_TEXT':
      return t('customer.documents.errors.notText', '{{name}} is not a plain UTF-8 text file. Save it as UTF-8 text and upload it again.', { name });
    case 'PDF_ENCRYPTED':
      return t('customer.documents.errors.encrypted', '{{name}} is password-protected. Remove the password and upload it again.', { name });
    case 'FILE_TOO_LARGE':
      return t('customer.documents.errors.tooLarge', '{{name}} is larger than {{size}}. Upload a smaller file.', {
        name, size: formatFileSize(maxBytes),
      });
    case 'PDF_ACTIVE_CONTENT':
      return t('customer.documents.errors.activeContent',
        '{{name}} contains active content (a script, an embedded file or a form action) and cannot be uploaded. '
        + 'Open it and print it to PDF, then upload that file.', { name });
    case 'PDF_TOO_COMPLEX':
      return t('customer.documents.errors.tooComplex',
        '{{name}} could not be checked. Open it and print it to PDF, then upload that file.', { name });
    case 'PDF_TOO_MANY_PAGES':
      return t('customer.documents.errors.tooManyPages', '{{name}} has too many pages to upload.', { name });
    case 'QUOTA_EXCEEDED':
      return t('customer.documents.errors.quota', 'There is not enough room for {{name}}. Ask your photographer to remove older documents.', { name });
    case 'DOCUMENT_REQUEST_NOT_FOUND':
      return t('customer.documents.errors.requestGone', 'The request for {{name}} is no longer open. Upload it without choosing a request, or ask your photographer.', { name });
    case 'UPLOAD_RATE_LIMITED':
      return t('customer.documents.errors.rateLimited', 'Too many uploads in a short time. Wait a few minutes, then try {{name}} again.', { name });
    default:
      return t('customer.documents.errors.generic', '{{name}} could not be uploaded. Please try again.', { name });
  }
}

/** A failed download, in words: the server answers each state with its own code. */
export function downloadErrorMessage(t: TFunction, code: string | undefined, status: number | undefined, name: string): string {
  if (code === 'DOCUMENT_PENDING_REVIEW') return t('customer.documents.errors.stillPending', '{{name}} is still being reviewed.', { name });
  if (code === 'DOCUMENT_UNSHARED') return t('customer.documents.errors.gone', '{{name}} is no longer shared with you.', { name });
  if (code === 'DOCUMENT_REMOVED' || code === 'DOCUMENT_PURGED') return t('customer.documents.errors.purged', '{{name}} has been removed.', { name });
  if (status === 404) return t('customer.documents.errors.notFound', '{{name}} could not be found.', { name });
  return t('customer.documents.errors.download', '{{name}} could not be downloaded. Please try again.', { name });
}

// The chips used hard-coded light Tailwind colours, which left the one thing
// this page exists to communicate unreadable on the portal's dark ground.
// `dark:` variants do NOT fix it here — the portal themes through tokens
// rather than the class the admin shell toggles on <html> — so the chip
// styles are token-derived in index.css instead.
export const STATUS_STYLE: Record<CustomerDocument['status'], string> = {
  clean: 'status-chip hue-success',
  pending: 'status-chip hue-warning',
  rejected: 'status-chip hue-danger',
};

export function statusLabel(t: TFunction, status: CustomerDocument['status']): string {
  if (status === 'clean') return t('customer.documents.status.available', 'Available');
  if (status === 'pending') return t('customer.documents.status.pending', 'Awaiting review');
  return t('customer.documents.status.rejected', 'Rejected');
}

/**
 * Delete one of the customer's own uploads, after a confirmation that says
 * the photographer may already have it. Resolves true once it is gone.
 */
export function useDeleteOwnDocument(): (doc: CustomerDocument) => Promise<boolean> {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  return async (doc) => {
    const ok = await confirm({
      title: t('customer.documents.deleteTitle', 'Delete this document?'),
      message: t('customer.documents.deleteBody', '{{name}} will be removed from your documents. Your photographer may already have downloaded it.', { name: doc.name }),
      confirmLabel: t('customer.documents.delete', 'Delete'),
      variant: 'danger',
    });
    if (!ok) return false;
    try {
      await customerService.deleteDocument(doc.id);
      toast.success(t('customer.documents.deleted', '{{name}} was deleted.', { name: doc.name }));
      await queryClient.invalidateQueries({ queryKey: ['customer-documents'] });
      await queryClient.invalidateQueries({ queryKey: ['customer-dashboard'] });
      return true;
    } catch (err: any) {
      const code = await readErrorCode(err);
      toast.error(code === 'DOCUMENT_CONTRACT_LINKED'
        ? t('customer.documents.errors.contractLinked', '{{name}} is part of a contract and cannot be deleted. Contact your photographer if it should be removed.', { name: doc.name })
        : t('customer.documents.errors.delete', '{{name}} could not be deleted. Please try again.', { name: doc.name }));
      return false;
    }
  };
}

/** The document list, shared with the per-event page. */
export const CustomerDocumentList: React.FC<{ documents: CustomerDocument[]; showEvent?: boolean }> = ({
  documents, showEvent = true,
}) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const [busyId, setBusyId] = useState<number | null>(null);
  const deleteOwn = useDeleteOwnDocument();

  const download = async (doc: CustomerDocument) => {
    setBusyId(doc.id);
    try {
      await customerService.downloadDocument(doc);
    } catch (err: any) {
      toast.error(downloadErrorMessage(t, await readErrorCode(err), err?.response?.status, doc.name));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
      {documents.map((doc) => (
        <li key={doc.id} className="p-4 flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Link to={`/customer/documents/${doc.id}`} className="text-sm font-medium text-theme break-all hover:underline">
                {doc.name}
              </Link>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[doc.status]}`}>
                {statusLabel(t, doc.status)}
              </span>
            </div>
            <p className="text-xs text-muted-theme mt-1">
              {doc.uploadedBy === 'you'
                ? t('customer.documents.fromYou', 'Uploaded by you')
                : t('customer.documents.fromStudio', 'Shared by your photographer')}
              {doc.createdAt && <>{' · '}{fmtDate(doc.createdAt)}</>}
              {' · '}{formatFileSize(doc.sizeBytes)}
              {showEvent && doc.eventName && <>{' · '}{doc.eventName}</>}
            </p>
            {doc.status === 'pending' && (
              <p className="text-xs text-muted-theme mt-1">
                {t('customer.documents.pendingHint', 'Your photographer checks every upload before it becomes available.')}
              </p>
            )}
            {doc.status === 'rejected' && (
              <p className="text-xs text-status hue-danger mt-1">
                {doc.rejectionReason
                  ? t('customer.documents.rejectedWithReason', 'Not accepted: {{reason}}', { reason: doc.rejectionReason })
                  : t('customer.documents.rejectedHint', 'Your photographer did not accept this file. Contact them if you are unsure why.')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {doc.downloadable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => download(doc)}
                disabled={busyId === doc.id}
                leftIcon={<Download className="w-4 h-4" />}
                aria-label={t('customer.documents.downloadAria', 'Download {{name}}', { name: doc.name })}
              >
                {t('customer.documents.download', 'Download')}
              </Button>
            )}
            {doc.canDelete && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={async () => {
                  setBusyId(doc.id);
                  try { await deleteOwn(doc); } finally { setBusyId(null); }
                }}
                disabled={busyId === doc.id}
                leftIcon={<Trash2 className="w-4 h-4" />}
                aria-label={t('customer.documents.deleteAria', 'Delete {{name}}', { name: doc.name })}
              >
                {t('customer.documents.delete', 'Delete')}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
};

export const CustomerDocumentsPage: React.FC = () => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customer-documents'],
    queryFn: () => customerService.listDocuments(),
  });
  const { data: events } = useQuery({
    queryKey: ['customer-events'],
    queryFn: () => customerService.listEvents(),
  });
  // What the studio asked for (slice 10). `?request=<id>` — the link in the
  // request mail and on the dashboard — preselects one for the upload.
  const { data: requests = [] } = useQuery({
    queryKey: ['customer-document-requests'],
    queryFn: () => customerService.listDocumentRequests(),
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const [requestId, setRequestId] = useState<number | null>(() => {
    const n = Number(searchParams.get('request'));
    return Number.isInteger(n) && n > 0 ? n : null;
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [eventId, setEventId] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  if (isLoading) return <Loading />;
  if (isError) {
    const status = (error as any)?.response?.status;
    return (
      <div className="container py-8">
        <h1 className="text-2xl font-bold text-theme mb-2">{t('customer.documents.title', 'Documents')}</h1>
        <p className={status === 403 ? 'text-muted-theme' : 'text-status hue-danger'}>
          {status === 403
            ? t('customer.documents.disabled', 'Documents are not available for your account.')
            : t('customer.documents.loadError', 'Could not load your documents.')}
        </p>
      </div>
    );
  }

  const documents = data?.documents ?? [];
  const limits = data?.limits;
  const formats = normaliseFormats(data?.allowedFormats);
  const formatNames = formatList(formats);
  const uploading = progress !== null;
  const selectedRequest = requests.find((r) => r.id === requestId) || null;

  const selectRequest = (id: number | null) => {
    setRequestId(id);
    const next = new URLSearchParams(searchParams);
    if (id) next.set('request', String(id)); else next.delete('request');
    setSearchParams(next, { replace: true });
    if (id) inputRef.current?.focus();
  };

  const chooseFile = (next: File | null) => {
    setResult(null);
    if (!next) { setFile(null); return; }
    // Checked again on the server, which decides by content.
    if (!allowedFormatOf(next.name, formats)) {
      setResult({ kind: 'error', message: uploadErrorMessage(t, 'FORMAT_NOT_ALLOWED', next.name, undefined, formatNames) });
      setFile(null);
      return;
    }
    if (limits && next.size > limits.maxUploadBytes) {
      setResult({ kind: 'error', message: uploadErrorMessage(t, 'FILE_TOO_LARGE', next.name, limits.maxUploadBytes) });
      setFile(null);
      return;
    }
    setFile(next);
  };

  const upload = async () => {
    if (!file || uploading) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setResult(null);
    setProgress(0);
    try {
      await customerService.uploadDocument(file, {
        eventId: eventId ? Number(eventId) : null,
        requestId: selectedRequest ? selectedRequest.id : null,
        signal: controller.signal,
        onProgress: setProgress,
      });
      if (selectedRequest) {
        selectRequest(null);
        await queryClient.invalidateQueries({ queryKey: ['customer-document-requests'] });
        await queryClient.invalidateQueries({ queryKey: ['customer-dashboard'] });
      }
      setResult({
        kind: 'success',
        message: t('customer.documents.uploaded', '{{name}} was received. It becomes available once your photographer has reviewed it.', { name: file.name }),
      });
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      await queryClient.invalidateQueries({ queryKey: ['customer-documents'] });
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED') {
        setResult({ kind: 'error', message: t('customer.documents.cancelled', 'Upload of {{name}} cancelled.', { name: file.name }) });
      } else {
        setResult({
          kind: 'error',
          message: uploadErrorMessage(t, await readErrorCode(err), file.name, limits?.maxUploadBytes, formatNames),
        });
      }
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme flex items-center gap-2">
          <FolderOpen className="w-6 h-6" />
          {t('customer.documents.title', 'Documents')}
        </h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('customer.documents.subtitle', 'Files your photographer shared with you, and documents you sent them.')}
        </p>
      </div>

      {requests.length > 0 && (
        <Card padding="none" className="mb-4">
          <h2 className="px-4 pt-4 pb-2 text-base font-semibold text-theme flex items-center gap-2">
            <Inbox className="w-5 h-5" />
            {t('customer.documents.requests.title', 'Requested by your photographer')}
          </h2>
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {requests.map((r) => (
              <li key={r.id} className="p-4 flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-theme break-words">{r.title}</p>
                  {r.note && <p className="text-xs text-muted-theme mt-1 break-words">{r.note}</p>}
                  {r.dueAt && (
                    <p className="text-xs text-muted-theme mt-1">
                      {t('customer.documents.requests.due', 'Needed by {{date}}', { date: fmtDate(r.dueAt) })}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant={r.id === requestId ? 'primary' : 'outline'}
                  size="sm"
                  disabled={uploading}
                  onClick={() => selectRequest(r.id)}
                  leftIcon={<Upload className="w-4 h-4" />}
                  aria-label={t('customer.documents.requests.uploadAria', 'Upload a file for {{title}}', { title: r.title })}
                >
                  {t('customer.documents.requests.upload', 'Upload for this request')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card padding="lg" className="mb-4">
        <h2 className="text-base font-semibold text-theme mb-1">{t('customer.documents.uploadTitle', 'Send a document')}</h2>
        {selectedRequest && (
          <p className="text-sm text-theme mb-2 flex items-center gap-2 flex-wrap">
            <span className="break-words">
              {t('customer.documents.requests.selected', 'This upload answers: {{title}}', { title: selectedRequest.title })}
            </span>
            <button type="button" className="underline text-muted-theme text-xs" onClick={() => selectRequest(null)} disabled={uploading}>
              {t('customer.documents.requests.clear', 'Not for this request')}
            </button>
          </p>
        )}
        <p className="text-xs text-muted-theme mb-3">
          {limits
            ? t('customer.documents.uploadHint', 'Accepted: {{formats}}, up to {{size}} per file. {{used}} of {{quota}} used.', {
              formats: formatNames,
              size: formatFileSize(limits.maxUploadBytes),
              used: formatFileSize(limits.usedBytes),
              quota: formatFileSize(limits.quotaBytes),
            })
            : t('customer.documents.uploadHintShort', 'Accepted: {{formats}}.', { formats: formatNames })}
        </p>
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="flex-1 min-w-0 text-sm text-theme">
            <span className="block mb-1">{t('customer.documents.fileLabel', 'File')}</span>
            <input
              ref={inputRef}
              type="file"
              accept={acceptFor(formats)}
              disabled={uploading}
              onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
          </label>
          {(events?.length ?? 0) > 0 && (
            <label className="text-sm text-theme">
              <span className="block mb-1">{t('customer.documents.eventLabel', 'Event (optional)')}</span>
              <select
                value={eventId}
                disabled={uploading}
                onChange={(e) => setEventId(e.target.value)}
                className="h-10 w-full sm:w-56 rounded-lg border px-2 text-sm"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  borderColor: 'var(--color-surface-border)',
                  color: 'var(--color-text)',
                }}
              >
                <option value="">{t('customer.documents.noEvent', 'No event')}</option>
                {events!.map((ev) => (
                  <option key={ev.id} value={ev.id}>{ev.eventName}</option>
                ))}
              </select>
            </label>
          )}
          {uploading ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => abortRef.current?.abort()}
              leftIcon={<X className="w-4 h-4" />}
            >
              {t('customer.documents.cancel', 'Cancel')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={upload}
              disabled={!file}
              leftIcon={<Upload className="w-4 h-4" />}
            >
              {result?.kind === 'error' && file
                ? t('customer.documents.retry', 'Try again')
                : t('customer.documents.upload', 'Upload')}
            </Button>
          )}
        </div>
        {uploading && (
          <progress
            className="mt-3 w-full"
            max={1}
            value={progress ?? 0}
            aria-label={t('customer.documents.progress', 'Upload progress')}
          />
        )}
        <div role="status" aria-live="polite" className="mt-3 text-sm">
          {result && (
            <p className={result.kind === 'success' ? 'text-status hue-success' : 'text-status hue-danger'}>{result.message}</p>
          )}
        </div>
      </Card>

      {documents.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-muted-theme py-8">
            {t('customer.documents.empty', 'No documents yet.')}
          </p>
        </Card>
      ) : (
        <Card padding="none">
          <CustomerDocumentList documents={documents} />
        </Card>
      )}
    </div>
  );
};

export default CustomerDocumentsPage;
