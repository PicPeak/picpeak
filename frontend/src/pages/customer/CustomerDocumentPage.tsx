/**
 * Customer portal → one document (`/customer/documents/:id`, #1444).
 *
 * The target of a deep link (a notification mail, a row on the list). The
 * server decides what the customer may see: a visible document comes back
 * with its status, and one they can no longer see comes back as a state —
 * no longer shared, removed, or not found — each with its own explanation,
 * so "it's gone" never looks the same as "it's still being checked".
 *
 * An unauthenticated visit goes through CustomerLayout's login redirect,
 * which keeps this path, and the query runs again after login: the target is
 * authorised again for whoever logged in.
 */
import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, FileText, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { formatFileSize } from '../../utils/fileSize';
import { customerService, type CustomerDocument } from '../../services/customer.service';
import {
  STATUS_STYLE, statusLabel, readErrorCode, downloadErrorMessage, useDeleteOwnDocument,
} from './CustomerDocumentsPage';

type Unavailable = 'unshared' | 'removed' | 'notFound' | 'disabled' | 'error';

function unavailableState(status: number | undefined, code: string | undefined): Unavailable {
  if (status === 410 && code === 'DOCUMENT_UNSHARED') return 'unshared';
  if (status === 410) return 'removed';
  if (status === 404) return 'notFound';
  if (status === 403) return 'disabled';
  return 'error';
}

function unavailableCopy(t: TFunction, state: Unavailable, studio: string): { title: string; body: string } {
  switch (state) {
    case 'unshared':
      return {
        title: t('customer.document.unsharedTitle', 'No longer shared'),
        body: t('customer.document.unsharedBody', 'This document is no longer shared with you. Ask {{studio}} if you still need it.', { studio }),
      };
    case 'removed':
      return {
        title: t('customer.document.removedTitle', 'Removed'),
        body: t('customer.document.removedBody', 'This document was removed and can no longer be opened. Ask {{studio}} if you still need it.', { studio }),
      };
    case 'notFound':
      return {
        title: t('customer.document.notFoundTitle', 'Document not found'),
        body: t('customer.document.notFoundBody', 'There is no document at this address for your account. Check that you are logged in with the right account.'),
      };
    case 'disabled':
      return {
        title: t('customer.document.disabledTitle', 'Documents are not available'),
        body: t('customer.documents.disabled', 'Documents are not available for your account.'),
      };
    default:
      return {
        title: t('customer.document.errorTitle', 'Could not load the document'),
        body: t('customer.document.errorBody', 'Please try again in a moment.'),
      };
  }
}

const BackLink: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Link to="/customer/documents" className="inline-flex items-center gap-1 text-sm text-muted-theme hover:underline mb-4">
      <ArrowLeft className="w-4 h-4" />
      {t('customer.document.back', 'All documents')}
    </Link>
  );
};

/** The explanation for a visible document that can't be downloaded (yet). */
function statusPanel(t: TFunction, doc: CustomerDocument, studio: string): { tone: string; text: string } | null {
  if (doc.status === 'pending') {
    return {
      tone: 'hue-warning',
      text: t('customer.document.pendingBody', 'This document is waiting for review. Every upload is checked by {{studio}} before it becomes available.', { studio }),
    };
  }
  if (doc.status === 'rejected') {
    return {
      tone: 'hue-danger',
      text: doc.rejectionReason
        ? t('customer.document.rejectedBody', 'This document was not accepted: {{reason}}', { reason: doc.rejectionReason })
        : t('customer.document.rejectedNoReason', 'This document was not accepted. Contact {{studio}} if you are unsure why.', { studio }),
    };
  }
  return null;
}

export const CustomerDocumentPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const documentId = Number(id);
  const validId = Number.isInteger(documentId) && documentId > 0;
  const { format: fmtDate } = useLocalizedDate();
  const { data: settings } = usePublicSettings();
  const studio = settings?.branding_company_name?.trim() || t('customer.document.yourPhotographer', 'your photographer');
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const deleteOwn = useDeleteOwnDocument();

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ['customer-document', documentId],
    queryFn: () => customerService.getDocument(documentId),
    enabled: validId,
    retry: false,
  });

  if (validId && isLoading) return <Loading />;

  if (!validId || error || !doc) {
    const res = (error as any)?.response;
    const state = validId ? unavailableState(res?.status, res?.data?.code) : 'notFound';
    const copy = unavailableCopy(t, state, studio);
    return (
      <div className="container py-6 max-w-3xl">
        <BackLink />
        <Card padding="lg">
          <div role="status" aria-live="polite">
            <h1 className="text-xl font-bold text-theme mb-2">{copy.title}</h1>
            <p className="text-sm text-muted-theme">{copy.body}</p>
          </div>
        </Card>
      </div>
    );
  }

  const panel = statusPanel(t, doc, studio);
  const download = async () => {
    setDownloading(true);
    try {
      await customerService.downloadDocument(doc);
    } catch (err: any) {
      toast.error(downloadErrorMessage(t, await readErrorCode(err), err?.response?.status, doc.name));
    } finally {
      setDownloading(false);
    }
  };

  const facts: Array<[string, React.ReactNode]> = [
    [t('customer.document.uploadedBy', 'From'), doc.uploadedBy === 'you'
      ? t('customer.documents.fromYou', 'Uploaded by you')
      : t('customer.documents.fromStudio', 'Shared by your photographer')],
    [t('customer.document.size', 'Size'), formatFileSize(doc.sizeBytes)],
  ];
  if (doc.createdAt) facts.push([t('customer.document.uploadedAt', 'Uploaded'), fmtDate(doc.createdAt)]);
  if (doc.sharedAt) facts.push([t('customer.document.sharedAt', 'Shared'), fmtDate(doc.sharedAt)]);
  if (doc.reviewedAt) facts.push([t('customer.document.reviewedAt', 'Reviewed'), fmtDate(doc.reviewedAt)]);
  if (doc.eventName) {
    facts.push([t('customer.document.event', 'Event'), doc.eventSlug
      ? <Link to={`/customer/events/${encodeURIComponent(doc.eventSlug)}`} className="hover:underline">{doc.eventName}</Link>
      : doc.eventName]);
  }

  return (
    <div className="container py-6 max-w-3xl">
      <BackLink />
      <Card padding="lg">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-theme flex items-start gap-2 break-all">
              <FileText className="w-5 h-5 mt-1 flex-shrink-0" />
              {doc.name}
            </h1>
            <span className={`inline-block mt-2 px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[doc.status]}`}>
              {statusLabel(t, doc.status)}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {doc.downloadable && (
              <Button
                type="button"
                variant="primary"
                onClick={download}
                disabled={downloading}
                leftIcon={<Download className="w-4 h-4" />}
                aria-label={t('customer.documents.downloadAria', 'Download {{name}}', { name: doc.name })}
              >
                {t('customer.documents.download', 'Download')}
              </Button>
            )}
            {doc.canDelete && (
              <Button
                type="button"
                variant="outline"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  const gone = await deleteOwn(doc);
                  setDeleting(false);
                  if (gone) navigate('/customer/documents');
                }}
                leftIcon={<Trash2 className="w-4 h-4" />}
                aria-label={t('customer.documents.deleteAria', 'Delete {{name}}', { name: doc.name })}
              >
                {t('customer.documents.delete', 'Delete')}
              </Button>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-theme">{label}</dt>
              <dd className="text-theme break-words">{value}</dd>
            </div>
          ))}
        </dl>

        <div role="status" aria-live="polite" className="mt-4">
          {panel && <p className={`text-sm text-status ${panel.tone}`}>{panel.text}</p>}
        </div>
      </Card>
    </div>
  );
};

export default CustomerDocumentPage;
