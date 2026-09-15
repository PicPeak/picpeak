/**
 * Customer portal → Documents (#1444).
 *
 * PDFs the photographer shared, plus the customer's own uploads. An upload
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
import { Download, FolderOpen, Upload, X } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { formatFileSize } from '../../utils/fileSize';
import { customerService, type CustomerDocument } from '../../services/customer.service';

/** Error code from an API error. Blob responses (downloads) carry JSON too. */
async function readErrorCode(err: any): Promise<string | undefined> {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text())?.code; } catch { return undefined; }
  }
  return data?.code;
}

export function uploadErrorMessage(t: TFunction, code: string | undefined, name: string, maxBytes?: number): string {
  switch (code) {
    case 'NOT_A_PDF':
      return t('customer.documents.errors.notPdf', '{{name}} is not a PDF. Only PDF documents can be uploaded.', { name });
    case 'PDF_ENCRYPTED':
      return t('customer.documents.errors.encrypted', '{{name}} is password-protected. Remove the password and upload it again.', { name });
    case 'FILE_TOO_LARGE':
      return t('customer.documents.errors.tooLarge', '{{name}} is larger than {{size}}. Upload a smaller file.', {
        name, size: formatFileSize(maxBytes),
      });
    case 'QUOTA_EXCEEDED':
      return t('customer.documents.errors.quota', 'There is not enough room for {{name}}. Ask your photographer to remove older documents.', { name });
    case 'UPLOAD_RATE_LIMITED':
      return t('customer.documents.errors.rateLimited', 'Too many uploads in a short time. Wait a few minutes, then try {{name}} again.', { name });
    default:
      return t('customer.documents.errors.generic', '{{name}} could not be uploaded. Please try again.', { name });
  }
}

const STATUS_STYLE: Record<CustomerDocument['status'], string> = {
  clean: 'bg-green-100 text-green-800',
  pending: 'bg-amber-100 text-amber-800',
  rejected: 'bg-red-100 text-red-800',
};

function statusLabel(t: TFunction, status: CustomerDocument['status']): string {
  if (status === 'clean') return t('customer.documents.status.available', 'Available');
  if (status === 'pending') return t('customer.documents.status.pending', 'Awaiting review');
  return t('customer.documents.status.rejected', 'Rejected');
}

/** The document list, shared with the per-event page. */
export const CustomerDocumentList: React.FC<{ documents: CustomerDocument[]; showEvent?: boolean }> = ({
  documents, showEvent = true,
}) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const [busyId, setBusyId] = useState<number | null>(null);

  const download = async (doc: CustomerDocument) => {
    setBusyId(doc.id);
    try {
      await customerService.downloadDocument(doc);
    } catch (err: any) {
      const code = await readErrorCode(err);
      const status = err?.response?.status;
      toast.error(
        code === 'DOCUMENT_PENDING_REVIEW'
          ? t('customer.documents.errors.stillPending', '{{name}} is still being reviewed.', { name: doc.name })
          : status === 404
            ? t('customer.documents.errors.gone', '{{name}} is no longer shared with you.', { name: doc.name })
            : status === 410
              ? t('customer.documents.errors.purged', '{{name}} has been removed.', { name: doc.name })
              : t('customer.documents.errors.download', '{{name}} could not be downloaded. Please try again.', { name: doc.name }),
      );
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
              <span className="text-sm font-medium text-theme break-all">{doc.name}</span>
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
              <p className="text-xs text-red-600 mt-1">
                {doc.rejectionReason
                  ? t('customer.documents.rejectedWithReason', 'Not accepted: {{reason}}', { reason: doc.rejectionReason })
                  : t('customer.documents.rejectedHint', 'Your photographer did not accept this file. Contact them if you are unsure why.')}
              </p>
            )}
          </div>
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
        </li>
      ))}
    </ul>
  );
};

export const CustomerDocumentsPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customer-documents'],
    queryFn: () => customerService.listDocuments(),
  });
  const { data: events } = useQuery({
    queryKey: ['customer-events'],
    queryFn: () => customerService.listEvents(),
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
        <p className={status === 403 ? 'text-muted-theme' : 'text-red-600'}>
          {status === 403
            ? t('customer.documents.disabled', 'Documents are not available for your account.')
            : t('customer.documents.loadError', 'Could not load your documents.')}
        </p>
      </div>
    );
  }

  const documents = data?.documents ?? [];
  const limits = data?.limits;
  const uploading = progress !== null;

  const chooseFile = (next: File | null) => {
    setResult(null);
    if (!next) { setFile(null); return; }
    // Checked again on the server, which decides by content.
    if (!/\.pdf$/i.test(next.name)) {
      setResult({ kind: 'error', message: uploadErrorMessage(t, 'NOT_A_PDF', next.name) });
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
        signal: controller.signal,
        onProgress: setProgress,
      });
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
        setResult({ kind: 'error', message: uploadErrorMessage(t, await readErrorCode(err), file.name, limits?.maxUploadBytes) });
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
          {t('customer.documents.subtitle', 'Files your photographer shared with you, and PDFs you sent them.')}
        </p>
      </div>

      <Card padding="lg" className="mb-4">
        <h2 className="text-base font-semibold text-theme mb-1">{t('customer.documents.uploadTitle', 'Send a document')}</h2>
        <p className="text-xs text-muted-theme mb-3">
          {limits
            ? t('customer.documents.uploadHint', 'PDF only, up to {{size}} per file. {{used}} of {{quota}} used.', {
              size: formatFileSize(limits.maxUploadBytes),
              used: formatFileSize(limits.usedBytes),
              quota: formatFileSize(limits.quotaBytes),
            })
            : t('customer.documents.uploadHintShort', 'PDF only.')}
        </p>
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="flex-1 min-w-0 text-sm text-theme">
            <span className="block mb-1">{t('customer.documents.fileLabel', 'PDF file')}</span>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
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
            <p className={result.kind === 'success' ? 'text-green-700' : 'text-red-600'}>{result.message}</p>
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
