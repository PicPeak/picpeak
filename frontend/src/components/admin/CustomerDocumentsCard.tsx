/**
 * Admin → customer record → Documents (#1444).
 *
 * Every endpoint behind this card needs `customers.documents.manage`, so the
 * list query is only enabled for holders of it and the card renders nothing
 * otherwise. Write controls sit inside PermissionGate as well.
 *
 * Customer uploads arrive `pending` and the customer can't download them until
 * someone here marks them clean. Downloads are always attachments — a file
 * from a customer is never opened in the admin's browser tab.
 */
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  CheckCircle2, Download, EyeOff, FolderOpen, Link2, Share2, Trash2, Upload, XCircle,
} from 'lucide-react';

import { Button, Card, Loading, useConfirm } from '../common';
import { PermissionGate } from './PermissionGate';
import { ProjectSelect } from './ProjectSelect';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { formatFileSize } from '../../utils/fileSize';
import { contractsService } from '../../services/contracts.service';
import {
  customerDocumentsAdminService,
  type AdminCustomerDocument,
} from '../../services/customerDocumentsAdmin.service';

const PERMISSION = 'customers.documents.manage';

const STATUS_STYLE: Record<AdminCustomerDocument['status'], string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  clean: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const selectClass = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 h-9 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 text-sm text-neutral-900 dark:text-neutral-100';

interface Props {
  customerId: number;
  /** The customer's assigned events — the only events a document can be linked to. */
  events: Array<{ id: number; eventName: string }>;
}

export const CustomerDocumentsCard: React.FC<Props> = ({ customerId, events }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { flags } = useFeatureFlags();
  const { hasPermission, isSuperAdmin } = usePermissions();
  const { format: fmtDate, formatDateTime: fmtDateTime } = useLocalizedDate();
  const canManage = isSuperAdmin || hasPermission(PERMISSION);
  // The contract picker reads the contracts list, which checks contracts.view.
  const canListContracts = flags.contracts && (isSuperAdmin || hasPermission('contracts.view'));
  // The project picker reads the projects list, which checks events.view.
  // Without it the select would render empty, so it isn't rendered at all.
  const canListProjects = !!flags.projects && (isSuperAdmin || hasPermission('events.view'));

  const queryKey = ['admin-customer-documents', customerId];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => customerDocumentsAdminService.list(customerId),
    enabled: canManage,
  });
  const { data: contractsRes } = useQuery({
    queryKey: ['admin-customer-document-contracts', customerId],
    queryFn: () => contractsService.list({ customerAccountId: customerId, page: 1, pageSize: 50, sort: 'newest' }),
    enabled: canManage && canListContracts,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [share, setShare] = useState(true);
  const [uploadEventId, setUploadEventId] = useState('');
  const [uploadProjectId, setUploadProjectId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<{ id: number; note: string } | null>(null);
  const [linking, setLinking] = useState<{
    id: number; eventId: string; projectId: number | null; contractId: string;
  } | null>(null);

  if (!canManage) return null;

  const errorText = (err: any) => err?.response?.data?.error
    || t('customers.documents.actionError', 'That did not work. Please try again.');

  const run = async (id: number | null, action: () => Promise<void>, success: string) => {
    setBusyId(id);
    try {
      await action();
      toast.success(success);
      await qc.invalidateQueries({ queryKey });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      await customerDocumentsAdminService.upload(customerId, file, {
        share,
        eventId: uploadEventId ? Number(uploadEventId) : null,
        projectId: canListProjects ? uploadProjectId : null,
      });
      toast.success(t('customers.documents.uploaded', '{{name}} uploaded.', { name: file.name }));
      setFile(null);
      setUploadProjectId(null);
      if (inputRef.current) inputRef.current.value = '';
      await qc.invalidateQueries({ queryKey });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setUploading(false);
    }
  };

  // Only the contract link changes; PATCH replaces all three links, so the
  // event and project go along unchanged.
  const unlinkContract = (doc: AdminCustomerDocument) => run(doc.id,
    () => customerDocumentsAdminService.setLinks(customerId, doc.id, {
      eventId: doc.eventId, projectId: doc.projectId, contractId: null,
    }),
    t('customers.documents.unlinked', 'Unlinked from the contract. You can delete it now.'));

  // A contract-linked document is part of the contractual record and the
  // server refuses to delete it (409 DOCUMENT_CONTRACT_LINKED). Say so up
  // front and offer the one way forward instead of a delete that fails.
  const offerUnlink = async (doc: AdminCustomerDocument) => {
    const ok = await confirm({
      title: t('customers.documents.linkedTitle', 'Linked to a contract'),
      message: t('customers.documents.linkedBody', '{{name}} is linked to a contract, so it is kept as part of the contractual record and cannot be deleted. Unlink it from the contract first, then delete it.', { name: doc.name }),
      confirmLabel: t('customers.documents.unlinkContract', 'Unlink from contract'),
      variant: 'warning',
    });
    if (ok) await unlinkContract(doc);
  };

  const remove = async (doc: AdminCustomerDocument) => {
    if (doc.contractId) {
      await offerUnlink(doc);
      return;
    }
    const ok = await confirm({
      title: t('customers.documents.deleteTitle', 'Delete document?'),
      message: t('customers.documents.deleteBody', '{{name}} disappears from the customer\'s portal at once. The file itself is removed after the retention period.', { name: doc.name }),
      confirmLabel: t('customers.documents.delete', 'Delete'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(doc.id);
    try {
      await customerDocumentsAdminService.remove(customerId, doc.id);
      toast.success(t('customers.documents.deleted', 'Document deleted.'));
    } catch (err: any) {
      // Linked since this list was loaded: show the reason and the way out.
      if (err?.response?.data?.code === 'DOCUMENT_CONTRACT_LINKED') {
        await qc.invalidateQueries({ queryKey });
        setBusyId(null);
        await offerUnlink(doc);
        return;
      }
      toast.error(errorText(err));
    } finally {
      setBusyId(null);
    }
    await qc.invalidateQueries({ queryKey });
  };

  const documents = data?.documents ?? [];
  const limits = data?.limits;
  const contracts = contractsRes?.contracts ?? [];

  const statusLabel = (status: AdminCustomerDocument['status']) => (
    status === 'pending'
      ? t('customers.documents.status.pending', 'Awaiting review')
      : status === 'clean'
        ? t('customers.documents.status.clean', 'Clean')
        : t('customers.documents.status.rejected', 'Rejected')
  );

  return (
    <Card padding="lg">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <FolderOpen className="w-5 h-5" />
        {t('customers.documents.title', 'Documents')}
      </h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        {t('customers.documents.hint', 'PDFs shared with this customer in their portal, and the files they sent you. A customer upload stays unavailable to them until you mark it clean.')}
        {limits && (
          <> {t('customers.documents.usage', 'Customer uploads: {{used}} of {{quota}}.', {
            used: formatFileSize(limits.usedBytes),
            quota: formatFileSize(limits.quotaBytes),
          })}</>
        )}
      </p>

      <PermissionGate permission={PERMISSION}>
        <div className="flex flex-col md:flex-row md:items-end gap-3 mb-4">
          <label className="flex-1 min-w-0 text-sm text-neutral-700 dark:text-neutral-300">
            <span className="block mb-1">{t('customers.documents.fileLabel', 'PDF to share')}</span>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              disabled={uploading}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-neutral-700 dark:text-neutral-300"
            />
          </label>
          {events.length > 0 && (
            <label className="text-sm text-neutral-700 dark:text-neutral-300">
              <span className="block mb-1">{t('customers.documents.eventLabel', 'Event')}</span>
              <select value={uploadEventId} onChange={(e) => setUploadEventId(e.target.value)} className={selectClass}>
                <option value="">{t('customers.documents.noLink', 'None')}</option>
                {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.eventName}</option>)}
              </select>
            </label>
          )}
          {canListProjects && (
            <ProjectSelect
              value={uploadProjectId}
              onChange={setUploadProjectId}
              label={t('customers.documents.projectLabel', 'Project')}
              customerAccountId={customerId}
              strictCustomer
              disabled={uploading}
              className="text-sm md:w-48"
            />
          )}
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300 md:pb-2">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="h-4 w-4" />
            {t('customers.documents.shareNow', 'Share with the customer')}
          </label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={upload}
            disabled={!file || uploading}
            isLoading={uploading}
            leftIcon={<Upload className="w-4 h-4" />}
          >
            {t('customers.documents.upload', 'Upload')}
          </Button>
        </div>
      </PermissionGate>

      {isLoading ? <Loading /> : isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          {t('customers.documents.loadError', 'Could not load documents.')}
        </p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.documents.empty', 'No documents yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {documents.map((doc) => {
            const busy = busyId === doc.id;
            return (
              <li key={doc.id} className="py-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 break-all">{doc.name}</span>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${STATUS_STYLE[doc.status]}`}>
                        {statusLabel(doc.status)}
                      </span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                        {doc.shared
                          ? t('customers.documents.shared', 'Shared')
                          : t('customers.documents.notShared', 'Not shared')}
                      </span>
                    </div>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      {doc.uploaderType === 'customer'
                        ? t('customers.documents.fromCustomer', 'Uploaded by the customer')
                        : t('customers.documents.fromAdmin', 'Uploaded by {{name}}', { name: doc.uploaderName || t('customers.documents.anAdmin', 'an admin') })}
                      {doc.createdAt && <>{' · '}{fmtDate(doc.createdAt)}</>}
                      {' · '}{formatFileSize(doc.sizeBytes)}
                      {doc.eventName && <>{' · '}{doc.eventName}</>}
                      {doc.contractNumber && <>{' · '}{doc.contractNumber}</>}
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {doc.customerLastViewedAt
                        ? t('customers.documents.viewed', 'Customer downloaded it {{times}}×, last {{date}}', {
                          times: doc.customerViewCount, date: fmtDateTime(doc.customerLastViewedAt),
                        })
                        : t('customers.documents.notViewed', 'Not downloaded by the customer yet')}
                    </p>
                    {doc.status === 'rejected' && doc.reviewNote && (
                      <p className="text-xs text-red-700 dark:text-red-400 mt-0.5">
                        {t('customers.documents.rejectedNote', 'Reason given: {{note}}', { note: doc.reviewNote })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Button
                      type="button" variant="ghost" size="sm" disabled={busy}
                      leftIcon={<Download className="w-4 h-4" />}
                      onClick={() => run(doc.id, () => customerDocumentsAdminService.download(customerId, doc),
                        t('customers.documents.downloadStarted', 'Download started.'))}
                    >
                      {t('customers.documents.download', 'Download')}
                    </Button>
                    <PermissionGate permission={PERMISSION}>
                      {doc.status !== 'clean' && (
                        <Button
                          type="button" variant="ghost" size="sm" disabled={busy}
                          leftIcon={<CheckCircle2 className="w-4 h-4" />}
                          onClick={() => run(doc.id, () => customerDocumentsAdminService.review(customerId, doc.id, 'clean'),
                            t('customers.documents.markedClean', 'Marked clean.'))}
                        >
                          {t('customers.documents.markClean', 'Mark clean')}
                        </Button>
                      )}
                      {doc.status !== 'rejected' && (
                        <Button
                          type="button" variant="ghost" size="sm" disabled={busy}
                          leftIcon={<XCircle className="w-4 h-4" />}
                          onClick={() => setRejecting({ id: doc.id, note: '' })}
                        >
                          {t('customers.documents.reject', 'Reject')}
                        </Button>
                      )}
                      {doc.status === 'clean' && (doc.shared ? (
                        <Button
                          type="button" variant="ghost" size="sm" disabled={busy}
                          leftIcon={<EyeOff className="w-4 h-4" />}
                          onClick={() => run(doc.id, () => customerDocumentsAdminService.unshare(customerId, doc.id),
                            t('customers.documents.unsharedToast', 'No longer shared.'))}
                        >
                          {t('customers.documents.unshare', 'Unshare')}
                        </Button>
                      ) : (
                        <Button
                          type="button" variant="ghost" size="sm" disabled={busy}
                          leftIcon={<Share2 className="w-4 h-4" />}
                          onClick={() => run(doc.id, () => customerDocumentsAdminService.share(customerId, doc.id),
                            t('customers.documents.sharedToast', 'Shared with the customer.'))}
                        >
                          {t('customers.documents.share', 'Share')}
                        </Button>
                      ))}
                      <Button
                        type="button" variant="ghost" size="sm" disabled={busy}
                        leftIcon={<Link2 className="w-4 h-4" />}
                        onClick={() => setLinking({
                          id: doc.id,
                          eventId: doc.eventId ? String(doc.eventId) : '',
                          projectId: doc.projectId,
                          contractId: doc.contractId ? String(doc.contractId) : '',
                        })}
                      >
                        {t('customers.documents.link', 'Link')}
                      </Button>
                      <Button
                        type="button" variant="ghost" size="sm" disabled={busy}
                        leftIcon={<Trash2 className="w-4 h-4 text-red-600" />}
                        onClick={() => remove(doc)}
                      >
                        {t('customers.documents.delete', 'Delete')}
                      </Button>
                    </PermissionGate>
                  </div>
                </div>

                {rejecting?.id === doc.id && (
                  <PermissionGate permission={PERMISSION}>
                    <div className="mt-2 flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        maxLength={500}
                        value={rejecting.note}
                        onChange={(e) => setRejecting({ id: doc.id, note: e.target.value })}
                        placeholder={t('customers.documents.rejectPlaceholder', 'Reason, shown to the customer (optional)')}
                        aria-label={t('customers.documents.rejectPlaceholder', 'Reason, shown to the customer (optional)')}
                        className="flex-1 h-9 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 text-sm text-neutral-900 dark:text-neutral-100"
                      />
                      <Button
                        type="button" variant="primary" size="sm" disabled={busy}
                        onClick={async () => {
                          await run(doc.id, () => customerDocumentsAdminService.review(customerId, doc.id, 'rejected', rejecting.note),
                            t('customers.documents.rejectedToast', 'Rejected.'));
                          setRejecting(null);
                        }}
                      >
                        {t('customers.documents.confirmReject', 'Reject file')}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setRejecting(null)}>
                        {t('common.cancel', 'Cancel')}
                      </Button>
                    </div>
                  </PermissionGate>
                )}

                {linking?.id === doc.id && (
                  <PermissionGate permission={PERMISSION}>
                    <div className="mt-2 flex flex-col sm:flex-row sm:items-end gap-2">
                      <label className="text-xs text-neutral-600 dark:text-neutral-400">
                        <span className="block mb-1">{t('customers.documents.eventLabel', 'Event')}</span>
                        <select
                          value={linking.eventId}
                          onChange={(e) => setLinking({ ...linking, eventId: e.target.value })}
                          className={selectClass}
                        >
                          <option value="">{t('customers.documents.noLink', 'None')}</option>
                          {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.eventName}</option>)}
                        </select>
                      </label>
                      {canListProjects && (
                        <ProjectSelect
                          value={linking.projectId}
                          onChange={(projectId) => setLinking({ ...linking, projectId })}
                          label={t('customers.documents.projectLabel', 'Project')}
                          customerAccountId={customerId}
                          strictCustomer
                          className="text-xs sm:w-48"
                        />
                      )}
                      {canListContracts && (
                        <label className="text-xs text-neutral-600 dark:text-neutral-400">
                          <span className="block mb-1">{t('customers.documents.contractLabel', 'Contract')}</span>
                          <select
                            value={linking.contractId}
                            onChange={(e) => setLinking({ ...linking, contractId: e.target.value })}
                            className={selectClass}
                          >
                            <option value="">{t('customers.documents.noLink', 'None')}</option>
                            {contracts.map((c) => <option key={c.id} value={c.id}>{c.contractNumber}</option>)}
                          </select>
                        </label>
                      )}
                      <Button
                        type="button" variant="primary" size="sm" disabled={busy}
                        onClick={async () => {
                          await run(doc.id, () => customerDocumentsAdminService.setLinks(customerId, doc.id, {
                            eventId: linking.eventId ? Number(linking.eventId) : null,
                            // PATCH replaces all three links: keep an existing
                            // project link when the picker isn't available.
                            projectId: canListProjects ? linking.projectId : doc.projectId,
                            // Keep an existing contract link when the picker isn't available.
                            contractId: canListContracts
                              ? (linking.contractId ? Number(linking.contractId) : null)
                              : doc.contractId,
                          }), t('customers.documents.linkSaved', 'Links saved.'));
                          setLinking(null);
                        }}
                      >
                        {t('customers.documents.saveLinks', 'Save links')}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setLinking(null)}>
                        {t('common.cancel', 'Cancel')}
                      </Button>
                    </div>
                  </PermissionGate>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
};

export default CustomerDocumentsCard;
