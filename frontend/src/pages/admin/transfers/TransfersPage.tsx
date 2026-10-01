/**
 * Admin → PicTransfer page (#997, split in #1544).
 *
 * PicTransfer does two jobs that used to share one row and one form:
 *
 *   Send files     pick originals from any event, add your own files, hand the
 *                  recipient a download link. Has a download cap and a ZIP.
 *   Request files  give a client an upload link and collect what they send.
 *                  Has no cap, no ZIP, and one deadline instead of two.
 *
 * They are separate kinds now, so the list filters by kind and each has its own
 * create dialog showing only the fields that mean anything for it. The detail
 * panel branches the same way.
 */
import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'react-toastify';
import {
  Plus, Send, Link2, Download, Trash2, Upload, X, Copy, Image as ImageIcon,
  Clock, Ban, RefreshCw, Mail, Paperclip, FileText, Inbox, KeyRound, ShieldAlert,
} from 'lucide-react';

import { Button, Input, Card, CardContent, Loading, useConfirm } from '../../../components/common';
import { AdminAuthenticatedImage } from '../../../components/admin/AdminAuthenticatedImage';
import { TransferPhotoPicker, type PickedPhoto } from '../../../components/admin/TransferPhotoPicker';
import { useMutationWithToast } from '../../../hooks/useMutationWithToast';
import { usePermission } from '../../../hooks/usePermission';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import {
  transfersService,
  type Transfer,
  type TransferKind,
  type TransferWriteResult,
} from '../../../services/transfers.service';

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function recipientUrl(token: string): string {
  return `${window.location.origin}/transfer/${token}`;
}
function uploadUrl(token: string): string {
  return `${window.location.origin}/transfer-upload/${token}`;
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  expired: 'bg-fill text-body',
  deleted: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

type TabKey = 'all' | 'send' | 'request';

/**
 * Warn about files the server took in but dropped on type. The create/upload
 * calls succeed with the good files, so without this the drop is silent.
 */
/**
 * Say what a write did not keep.
 *
 * The routes answer 201/200 with the good files stored and the rest named
 * alongside, so without this the drop is silent — the admin sees "Transfer
 * created" and a file they picked is simply not there.
 */
function warnWriteNotes(
  result: TransferWriteResult | undefined,
  t: TFunction,
) {
  const rejected = result?.rejected_files || [];
  const dropped = result?.dropped_files || [];
  if (rejected.length) {
    toast.warn(t(
      'transfers.someRejected',
      '{{count}} file(s) were not an allowed type and were skipped: {{names}}',
      { count: rejected.length, names: rejected.join(', ') },
    ));
  }
  if (dropped.length) {
    toast.warn(t(
      'transfers.someDropped',
      '{{count}} attached file(s) were not kept — a file request only collects files: {{names}}',
      { count: dropped.length, names: dropped.join(', ') },
    ));
  }
}

export const TransfersPage: React.FC = () => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { formatDateTime } = useLocalizedDate();
  const fmtDate = (d: string | null) => (d ? formatDateTime(d) : '—');
  const [createKind, setCreateKind] = useState<TransferKind | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabKey>('all');
  // Creating and changing transfers is events.edit on the server; without this
  // a read-only admin sees both create buttons and earns a 403 toast.
  const canEdit = usePermission('events.edit');
  const canView = usePermission('events.view');

  const { data: transfers, isLoading, refetch } = useQuery({
    queryKey: ['admin-transfers'],
    queryFn: () => transfersService.list(),
    // Hiding the control is not enough — the list endpoint is events.view, so
    // without this an admin who lacks it still fires a request that 403s.
    enabled: canView,
  });

  const counts = useMemo(() => ({
    all: transfers?.length || 0,
    send: transfers?.filter((tr) => tr.kind === 'send').length || 0,
    request: transfers?.filter((tr) => tr.kind === 'request').length || 0,
  }), [transfers]);

  const visible = useMemo(
    () => (tab === 'all' ? transfers || [] : (transfers || []).filter((tr) => tr.kind === tab)),
    [transfers, tab],
  );

  const copyLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('transfers.linkCopied', 'Link copied to clipboard'));
    } catch {
      toast.error(t('transfers.copyFailed', 'Could not copy link'));
    }
  };

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'all', label: t('transfers.tab.all', 'All') },
    { key: 'send', label: t('transfers.tab.sent', 'Sent') },
    { key: 'request', label: t('transfers.tab.requested', 'Requested') },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-heading">
            <Send className="h-6 w-6" /> {t('transfers.title', 'PicTransfer')}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t('transfers.subtitle', 'Send files to a client, or ask a client to send files to you.')}
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              leftIcon={<Inbox className="h-4 w-4" />}
              onClick={() => setCreateKind('request')}
            >
              {t('transfers.newRequest', 'Request files')}
            </Button>
            <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreateKind('send')}>
              {t('transfers.newSend', 'Send files')}
            </Button>
          </div>
        )}
      </div>

      {/* Kind filter. Shown whenever there is anything to filter, so the two
          flows stay visible to someone who has only ever used one of them. */}
      {!isLoading && counts.all > 0 && (
        <div className="flex gap-1 border-b border-line">
          {TABS.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                tab === tb.key
                  ? 'border-primary-600 text-primary-700 dark:text-primary-400'
                  : 'border-transparent text-muted hover:text-body'
              }`}
            >
              {tb.label} <span className="text-muted">({counts[tb.key]})</span>
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted">
            <Send className="mx-auto mb-3 h-10 w-10 text-muted" />
            <p>
              {counts.all === 0
                ? (canEdit
                  ? t('transfers.empty', 'Nothing here yet. Send files to a client, or ask them to send you some.')
                  : t('transfers.emptyReadOnly', 'Nothing here yet.'))
                : t('transfers.emptyTab', 'Nothing in this tab yet.')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="px-4 py-3 font-medium">{t('transfers.col.title', 'Title')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.kind', 'Type')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.files', 'Files')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.status', 'Status')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.downloads', 'Downloads')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.deadline', 'Deadline')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((tr) => {
                  const isRequest = tr.kind === 'request';
                  return (
                    <tr
                      key={tr.id}
                      className="cursor-pointer border-b border-line-faint hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                      onClick={() => setDetailId(tr.id)}
                    >
                      <td className="px-4 py-3 font-medium text-heading">
                        {tr.title || t('transfers.untitled', 'Untitled transfer')}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs text-soft">
                          {isRequest
                            ? <><Inbox className="h-3.5 w-3.5" /> {t('transfers.kind.request', 'Request')}</>
                            : <><Send className="h-3.5 w-3.5" /> {t('transfers.kind.send', 'Send')}</>}
                        </span>
                      </td>
                      {/* A send counts what goes out; a request counts what came in. */}
                      <td className="px-4 py-3">{isRequest ? tr.upload_count : tr.file_count}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[tr.status] || ''}`}>
                          {t(`transfers.status.${tr.status}`, tr.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {isRequest
                          ? <span className="text-muted">—</span>
                          : `${tr.download_count}${tr.max_downloads ? ` / ${tr.max_downloads}` : ''}`}
                      </td>
                      <td className="px-4 py-3 text-muted">{fmtDate(tr.expires_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {createKind && (
        <CreateTransferModal
          kind={createKind}
          onClose={() => setCreateKind(null)}
          onCreated={() => { setCreateKind(null); refetch(); }}
        />
      )}
      {detailId !== null && (
        <TransferDetailModal
          transferId={detailId}
          onClose={() => { setDetailId(null); refetch(); }}
          onCopy={copyLink}
          confirm={confirm}
          canEdit={canEdit}
          canView={canView}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Create modal — one component, two shapes
// ---------------------------------------------------------------------------

const CreateTransferModal: React.FC<{
  kind: TransferKind;
  onClose: () => void;
  onCreated: () => void;
}> = ({ kind, onClose, onCreated }) => {
  const { t } = useTranslation();
  const isRequest = kind === 'request';

  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('14');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [picked, setPicked] = useState<PickedPhoto[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // A request is pointless without reaching the client, so it defaults to email.
  const [deliveryMethod, setDeliveryMethod] = useState<'link' | 'email'>(isRequest ? 'email' : 'link');
  const [emails, setEmails] = useState('');

  // Split the free-text recipient field on comma / semicolon / whitespace and
  // keep only well-formed addresses. Used both to send and to gate the button.
  const parsedEmails = emails
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  const createMutation = useMutationWithToast({
    mutationFn: () => transfersService.create({
      kind,
      title: title.trim(),
      message: message.trim() || null,
      expiresInDays: parseInt(expiresInDays, 10) || 14,
      maxDownloads: !isRequest && maxDownloads ? parseInt(maxDownloads, 10) : null,
      photoIds: isRequest ? [] : picked.map((p) => p.id),
      files: isRequest ? [] : files,
      deliveryMethod,
      recipientEmails: deliveryMethod === 'email' ? parsedEmails : [],
    }),
    successMessage: isRequest
      ? t('transfers.requestCreated', 'File request created')
      : t('transfers.created', 'Transfer created'),
    // Fallback only — useMutationWithToast shows the server's own message first.
    errorMessage: isRequest
      ? t('transfers.requestCreateFailed', 'Could not create the file request')
      : t('transfers.createFailed', 'Could not create transfer'),
    onSuccess: (transfer) => {
      warnWriteNotes(transfer, t);
      onCreated();
    },
  });

  const addFilesToList = (list: FileList | null) => {
    if (!list || !list.length) return;
    // Copy now: the caller clears the input right after, which empties this
    // live FileList, and React may run the updater only on the next render.
    const incoming = Array.from(list);
    setFiles((prev) => [...prev, ...incoming]);
  };

  const addPicked = (photos: PickedPhoto[]) => {
    setPicked((prev) => {
      const map = new Map(prev.map((p) => [p.id, p]));
      photos.forEach((p) => map.set(p.id, p));
      return Array.from(map.values());
    });
    setShowPicker(false);
  };

  // A send needs something to send. A request needs somewhere to send the ask,
  // unless the operator is going to hand the link over themselves.
  const canSubmit = isRequest
    ? !(deliveryMethod === 'email' && parsedEmails.length === 0)
    : (picked.length > 0 || files.length > 0) && !(deliveryMethod === 'email' && parsedEmails.length === 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-shell shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-heading">
            {isRequest
              ? <><Inbox className="h-5 w-5" /> {t('transfers.newRequest', 'Request files')}</>
              : <><Send className="h-5 w-5" /> {t('transfers.newSend', 'Send files')}</>}
          </h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-hover-soft"><X className="h-5 w-5" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <Input
            label={t('transfers.field.title', 'Title')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={isRequest
              ? t('transfers.field.requestTitlePlaceholder', 'e.g. Logo and brand assets for the Smiths')
              : t('transfers.field.titlePlaceholder', 'e.g. Wedding finals for the Smiths')}
          />
          <div>
            <label className="mb-1 block text-sm font-medium text-body">
              {isRequest
                ? t('transfers.field.requestMessage', 'What do you need from them? (optional)')
                : t('transfers.field.message', 'Message (optional)')}
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-line-strong px-3 py-2 text-sm dark:bg-neutral-800"
              placeholder={isRequest
                ? t('transfers.field.requestMessagePlaceholder', 'Shown to the client on the upload page')
                : t('transfers.field.messagePlaceholder', 'Shown to the recipient on the download page')}
            />
          </div>

          {/* A request has one deadline and no download cap. */}
          <div className={isRequest ? '' : 'grid grid-cols-2 gap-4'}>
            <Input
              type="number"
              min={1}
              label={isRequest
                ? t('transfers.field.uploadWindowDays', 'Accept uploads for (days)')
                : t('transfers.field.expiresInDays', 'Link active for (days)')}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
            {!isRequest && (
              <Input
                type="number"
                min={0}
                label={t('transfers.field.maxDownloads', 'Max downloads (0 = unlimited)')}
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
                placeholder="0"
              />
            )}
          </div>

          {/* Outbound content — sends only. */}
          {!isRequest && (
            <>
              <div className="rounded-md border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-body">
                    {t('transfers.field.files', 'Files')} · {picked.length}
                  </span>
                  <Button size="sm" variant="outline" leftIcon={<ImageIcon className="h-4 w-4" />} onClick={() => setShowPicker(true)}>
                    {t('transfers.picker.title', 'Select images from other events')}
                  </Button>
                </div>
                {picked.length === 0 ? (
                  <p className="text-sm text-muted">{t('transfers.field.noFiles', 'No images selected yet.')}</p>
                ) : (
                  <div className="grid grid-cols-6 gap-2">
                    {picked.slice(0, 18).map((p) => (
                      <div key={p.id} className="relative aspect-square overflow-hidden rounded">
                        {p.thumbnail_url ? (
                          <AdminAuthenticatedImage src={p.thumbnail_url} alt={p.filename} className="h-full w-full object-cover" />
                        ) : <div className="h-full w-full bg-subtle" />}
                        <button
                          onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                          className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                        ><X className="h-3 w-3" /></button>
                      </div>
                    ))}
                    {picked.length > 18 && (
                      <div className="flex aspect-square items-center justify-center rounded bg-subtle text-xs text-muted">
                        +{picked.length - 18}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-md border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-body">
                    {t('transfers.field.uploadFiles', 'Upload your own files')} · {files.length}
                  </span>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1.5 text-sm text-body hover:bg-hover-soft">
                    <Upload className="h-4 w-4" />
                    {t('transfers.field.chooseFiles', 'Choose files')}
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => { addFilesToList(e.target.files); e.target.value = ''; }}
                    />
                  </label>
                </div>
                {files.length === 0 ? (
                  <p className="text-sm text-muted">{t('transfers.field.noUploadFiles', 'Optionally add files from your computer to send along.')}</p>
                ) : (
                  <ul className="divide-y divide-line-faint">
                    {files.map((f, idx) => (
                      <li key={`${f.name}-${idx}`} className="flex items-center justify-between py-1.5 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-muted" />
                          <span className="truncate text-body">{f.name}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                          className="rounded p-1 text-muted hover:bg-hover hover:text-soft"
                        ><X className="h-3.5 w-3.5" /></button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {/* Delivery: copy a link yourself, or email it. */}
          <div className="rounded-md border border-line p-3">
            <span className="mb-2 block text-sm font-medium text-body">
              {t('transfers.field.delivery', 'Delivery')}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={deliveryMethod === 'link' ? 'primary' : 'outline'}
                className="flex-1"
                leftIcon={<Link2 className="h-4 w-4" />}
                onClick={() => setDeliveryMethod('link')}
              >
                {t('transfers.delivery.link', 'Share a link')}
              </Button>
              <Button
                type="button"
                variant={deliveryMethod === 'email' ? 'primary' : 'outline'}
                className="flex-1"
                leftIcon={<Mail className="h-4 w-4" />}
                onClick={() => setDeliveryMethod('email')}
              >
                {t('transfers.delivery.email', 'Send by email')}
              </Button>
            </div>
            {deliveryMethod === 'email' && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-body">
                  {t('transfers.field.recipients', 'Recipient email addresses')}
                </label>
                <textarea
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-line-strong px-3 py-2 text-sm dark:bg-neutral-800"
                  placeholder={t('transfers.field.recipientsPlaceholder', 'anna@example.com, ben@example.com')}
                />
                <p className="mt-1 text-xs text-muted">
                  {isRequest
                    ? t('transfers.field.requestRecipientsHint', 'Separate multiple addresses with commas. Each one gets the upload link.')
                    : t('transfers.field.recipientsHint', 'Separate multiple addresses with commas. Each recipient gets the download link.')}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button
            onClick={() => createMutation.mutate()}
            isLoading={createMutation.isPending}
            disabled={!canSubmit}
          >
            {isRequest
              ? (deliveryMethod === 'email'
                ? t('transfers.createRequestAndSend', 'Create & ask')
                : t('transfers.createRequest', 'Create request'))
              : (deliveryMethod === 'email'
                ? t('transfers.createAndSend', 'Create & send')
                : t('transfers.create', 'Create transfer'))}
          </Button>
        </div>
      </div>

      {showPicker && (
        <TransferPhotoPicker
          onClose={() => setShowPicker(false)}
          onConfirm={addPicked}
          excludePhotoIds={picked.map((p) => p.id)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

interface DetailProps {
  transferId: number;
  onClose: () => void;
  onCopy: (text: string) => void;
  confirm: ReturnType<typeof useConfirm>;
  /** events.edit — every mutating control below is hidden without it. */
  canEdit: boolean;
  /** events.view — gates the detail query itself. */
  canView: boolean;
}

const TransferDetailModal: React.FC<DetailProps> = ({ transferId, onClose, onCopy, confirm, canEdit, canView }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const fmtDate = (d: string | null) => (d ? formatDateTime(d) : '—');
  const [showPicker, setShowPicker] = useState(false);

  const { data: transfer, isLoading, refetch } = useQuery({
    queryKey: ['admin-transfer', transferId],
    queryFn: () => transfersService.get(transferId),
    enabled: canView,
  });
  const isRequest = transfer?.kind === 'request';
  // The ZIP route is photos.download, NOT events.edit — a different permission
  // from everything else in this modal. It is a plain <a href>, so an admin
  // without it would navigate to raw 403 JSON rather than see an error toast.
  const canDownload = usePermission('photos.download');

  const addFilesMutation = useMutationWithToast({
    mutationFn: (photoIds: number[]) => transfersService.addFiles(transferId, photoIds),
    successMessage: t('transfers.filesAdded', 'Files added'),
    onSuccess: () => refetch(),
  });
  const removeFileMutation = useMutationWithToast({
    mutationFn: (fileId: number) => transfersService.removeFile(transferId, fileId),
    onSuccess: () => refetch(),
  });
  const disableMutation = useMutationWithToast({
    mutationFn: () => transfersService.update(transferId, { isActive: false }),
    successMessage: isRequest
      ? t('transfers.requestClosed', 'Request closed')
      : t('transfers.disabled', 'Link disabled'),
    onSuccess: () => refetch(),
  });
  const reactivateMutation = useMutationWithToast({
    mutationFn: () => transfersService.update(transferId, { isActive: true, expiresInDays: 14 }),
    successMessage: t('transfers.reactivated', 'Link re-activated'),
    onSuccess: () => refetch(),
  });
  const issueCodeMutation = useMutationWithToast({
    mutationFn: (rotate: boolean) => transfersService.issueUploadCode(transferId, rotate),
    successMessage: t('transfers.codeIssued', 'Upload code issued'),
    onSuccess: () => refetch(),
  });
  const revokeCodeMutation = useMutationWithToast({
    mutationFn: () => transfersService.revokeUploadCode(transferId),
    successMessage: t('transfers.codeRevoked', 'Upload code withdrawn'),
    onSuccess: () => refetch(),
  });
  const resendMutation = useMutationWithToast({
    mutationFn: () => transfersService.resendEmail(transferId),
    successMessage: t('transfers.emailResent', 'Email sent again'),
    onSuccess: () => refetch(),
  });
  const deleteMutation = useMutationWithToast({
    mutationFn: () => transfersService.remove(transferId),
    successMessage: t('transfers.deleted', 'Transfer deleted'),
    onSuccess: onClose,
  });
  const uploadFilesMutation = useMutationWithToast({
    mutationFn: (list: File[]) => transfersService.uploadFiles(transferId, list),
    successMessage: t('transfers.filesAdded', 'Files added'),
    onSuccess: (updated) => {
      warnWriteNotes(updated, t);
      refetch();
    },
  });
  const removeExtraFileMutation = useMutationWithToast({
    mutationFn: (extraId: number) => transfersService.removeExtraFile(transferId, extraId),
    onSuccess: () => refetch(),
  });

  const handleDelete = async () => {
    const ok = await confirm({
      title: isRequest
        ? t('transfers.deleteRequestConfirmTitle', 'Delete file request?')
        : t('transfers.deleteConfirmTitle', 'Delete transfer?'),
      message: isRequest
        ? t('transfers.deleteRequestConfirmBody', 'This removes the upload link and permanently deletes every file the client sent.')
        : t('transfers.deleteConfirmBody', 'This removes the link. Source event photos are not affected.'),
      variant: 'danger',
    });
    if (ok) deleteMutation.mutate();
  };

  const primaryLink = transfer
    ? (isRequest ? uploadUrl(transfer.token) : recipientUrl(transfer.token))
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-shell shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold text-heading">
            {transfer && (isRequest ? <Inbox className="h-5 w-5 shrink-0" /> : <Send className="h-5 w-5 shrink-0" />)}
            <span className="truncate">{transfer?.title || t('transfers.untitled', 'Untitled transfer')}</span>
          </h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-hover-soft"><X className="h-5 w-5" /></button>
        </div>

        {isLoading || !transfer ? (
          <div className="p-8"><Loading /></div>
        ) : (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {/* The one link that matters for this kind, up top. */}
            <div className="rounded-lg border border-line bg-neutral-50 p-4 dark:bg-neutral-800/50">
              <div className="flex flex-wrap items-center gap-2">
                <Input readOnly value={primaryLink} className="flex-1 min-w-[220px]" />
                <Button variant="outline" leftIcon={<Copy className="h-4 w-4" />} onClick={() => onCopy(primaryLink)}>
                  {t('transfers.copyLink', 'Copy link')}
                </Button>
                {/* A request has no outgoing bundle to zip. */}
                {!isRequest && canDownload && (
                  <a href={transfersService.adminDownloadUrl(transfer.id)}>
                    <Button leftIcon={<Download className="h-4 w-4" />}>{t('transfers.downloadAll', 'Download all')}</Button>
                  </a>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-sm text-soft">
                <span className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  {isRequest ? t('transfers.uploadBy', 'Accepts uploads until') : t('transfers.expiresOn', 'Expires')}: {fmtDate(transfer.expires_at)}
                </span>
                {isRequest ? (
                  <span>{t('transfers.filesReceived', 'Files received')}: {transfer.upload_count}</span>
                ) : (
                  <span>{t('transfers.col.downloads', 'Downloads')}: {transfer.download_count}{transfer.max_downloads ? ` / ${transfer.max_downloads}` : ''}</span>
                )}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[transfer.status] || ''}`}>{t(`transfers.status.${transfer.status}`, transfer.status)}</span>
              </div>
              {canEdit && (
              <div className="mt-3 flex flex-wrap gap-2">
                {transfer.is_active ? (
                  <Button size="sm" variant="outline" leftIcon={<Ban className="h-4 w-4" />} onClick={() => disableMutation.mutate()} isLoading={disableMutation.isPending}>
                    {isRequest ? t('transfers.closeRequest', 'Close request') : t('transfers.disableLink', 'Disable link')}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={() => reactivateMutation.mutate()} isLoading={reactivateMutation.isPending}>
                    {t('transfers.reactivate', 'Re-activate (14 days)')}
                  </Button>
                )}
                {transfer.recipients && transfer.recipients.length > 0 && (
                  <Button size="sm" variant="outline" leftIcon={<Mail className="h-4 w-4" />} onClick={() => resendMutation.mutate()} isLoading={resendMutation.isPending}>
                    {t('transfers.resend', 'Send again')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-red-600" leftIcon={<Trash2 className="h-4 w-4" />} onClick={handleDelete}>
                  {t('common.delete', 'Delete')}
                </Button>
              </div>
              )}
            </div>

            {/* ---------------- Send-only sections ---------------- */}
            {!isRequest && (
              <>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-body">{t('transfers.field.files', 'Files')} · {transfer.file_count}</h3>
                    {canEdit && (
                      <Button size="sm" variant="outline" leftIcon={<ImageIcon className="h-4 w-4" />} onClick={() => setShowPicker(true)}>
                        {t('transfers.addImages', 'Add images')}
                      </Button>
                    )}
                  </div>
                  {transfer.files && transfer.files.length > 0 ? (
                    <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
                      {transfer.files.map((f) => (
                        <div key={f.file_id} className="group relative aspect-square overflow-hidden rounded">
                          <AdminAuthenticatedImage src={f.thumbnail_url} alt={f.filename} className="h-full w-full object-cover" />
                          {canEdit && (
                            <button
                              onClick={() => removeFileMutation.mutate(f.file_id)}
                              className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition group-hover:opacity-100"
                              title={t('common.remove', 'Remove')}
                            ><X className="h-3 w-3" /></button>
                          )}
                          <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 py-0.5 text-[10px] text-white" title={f.event_name}>{f.event_name}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted">{t('transfers.field.noFiles', 'No images selected yet.')}</p>
                  )}
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-body">
                      <Paperclip className="h-4 w-4" /> {t('transfers.uploadedFiles', 'Uploaded files')} · {transfer.extra_files?.length || 0}
                    </h3>
                    {canEdit && (
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1.5 text-sm text-body hover:bg-hover-soft">
                        <Upload className="h-4 w-4" />
                        {t('transfers.addFiles', 'Add files')}
                        <input
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files?.length) uploadFilesMutation.mutate(Array.from(e.target.files));
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}
                  </div>
                  {transfer.extra_files && transfer.extra_files.length > 0 ? (
                    <ul className="divide-y divide-line-faint">
                      {transfer.extra_files.map((f) => (
                        <li key={f.id} className="flex items-center justify-between py-2 text-sm">
                          <span className="flex min-w-0 items-center gap-2">
                            <FileText className="h-4 w-4 shrink-0 text-muted" />
                            <span className="truncate text-body">{f.filename}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-3 text-muted">
                            <span>{formatBytes(f.size_bytes)}</span>
                            <a href={transfersService.adminExtraFileDownloadUrl(transferId, f.id)} className="text-primary-600 hover:underline">
                              <Download className="h-4 w-4" />
                            </a>
                            {canEdit && (
                              <button
                                onClick={() => removeExtraFileMutation.mutate(f.id)}
                                className="rounded p-1 text-muted hover:bg-hover hover:text-red-600"
                                title={t('common.remove', 'Remove')}
                              ><X className="h-3.5 w-3.5" /></button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">{t('transfers.noUploadedFiles', 'No uploaded files. Add files from your computer to include them in the download.')}</p>
                  )}
                </div>
              </>
            )}

            {/* ---------------- Request-only sections ---------------- */}
            {isRequest && (
              <>
                {/* The short read-aloud code, which is optional on a request. */}
                <div className="rounded-lg border border-line p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-body">
                      <KeyRound className="h-4 w-4" /> {t('transfers.uploadCode', 'Short upload code')}
                    </h3>
                    {!canEdit ? null : transfer.upload_code ? (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={() => issueCodeMutation.mutate(true)} isLoading={issueCodeMutation.isPending}>
                          {t('transfers.rotateCode', 'New code')}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-600" onClick={() => revokeCodeMutation.mutate()}>
                          {t('transfers.revokeCode', 'Withdraw')}
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => issueCodeMutation.mutate(false)} isLoading={issueCodeMutation.isPending}>
                        {t('transfers.issueCode', 'Issue a code')}
                      </Button>
                    )}
                  </div>
                  {transfer.upload_code ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="rounded bg-subtle px-3 py-1.5 font-mono text-lg tracking-widest">{transfer.upload_code}</div>
                      <Input readOnly value={uploadUrl(transfer.upload_code)} className="flex-1 min-w-[200px]" />
                      <Button variant="outline" size="sm" leftIcon={<Copy className="h-4 w-4" />} onClick={() => onCopy(uploadUrl(transfer.upload_code as string))}>
                        {t('transfers.copyLink', 'Copy link')}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">
                      {t('transfers.codeHint', 'Optional: a short code you can read out over the phone. The full link above always works.')}
                    </p>
                  )}
                </div>

                {/* What the client sent. */}
                <div className="rounded-lg border border-line p-4">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-body">
                    <Inbox className="h-4 w-4" /> {t('transfers.filesReceived', 'Files received')} · {transfer.upload_count}
                  </h3>
                  {transfer.uploads && transfer.uploads.length > 0 ? (
                    <>
                      <ul className="divide-y divide-line-faint">
                        {transfer.uploads.map((u) => (
                          <li key={u.id} className="flex items-center justify-between py-2 text-sm">
                            <span className="flex min-w-0 items-center gap-2">
                              <FileText className="h-4 w-4 shrink-0 text-muted" />
                              <span className="truncate text-body">{u.original_filename}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-3 text-muted">
                              <span>{fmtDate(u.uploaded_at)}</span>
                              <span>{formatBytes(u.size_bytes)}</span>
                              <a href={transfersService.adminUploadDownloadUrl(transferId, u.id)} className="text-primary-600 hover:underline">
                                <Download className="h-4 w-4" />
                              </a>
                            </span>
                          </li>
                        ))}
                      </ul>
                      {/* These bytes came from outside and nothing here has
                          opened them. Say so where the admin is about to. */}
                      <p className="mt-3 flex items-start gap-2 text-xs text-muted">
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {t('transfers.unscannedNote', 'These files are stored exactly as received and are never opened or scanned by PicPeak. Check them before you use or pass them on.')}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted">{t('transfers.noUploads', 'No files uploaded by the client yet.')}</p>
                  )}
                </div>
              </>
            )}

            {/* Email recipients (both kinds) */}
            {transfer.recipients && transfer.recipients.length > 0 && (
              <div className="rounded-lg border border-line p-4">
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-body">
                  <Mail className="h-4 w-4" /> {isRequest ? t('transfers.askedOf', 'Asked of') : t('transfers.sentTo', 'Emailed to')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {transfer.recipients.map((r) => (
                    <span key={r.id} className="rounded-full bg-subtle px-2.5 py-1 text-xs text-body">
                      {r.email}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showPicker && transfer && (
        <TransferPhotoPicker
          onClose={() => setShowPicker(false)}
          onConfirm={(photos) => { addFilesMutation.mutate(photos.map((p) => p.id)); setShowPicker(false); }}
          excludePhotoIds={(transfer.files || []).map((f) => f.photo_id)}
          isSaving={addFilesMutation.isPending}
        />
      )}
    </div>
  );
};

export type { Transfer };
