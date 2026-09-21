/**
 * Admin → PicTransfer page (#997).
 *
 * List of transfers + a create flow (with the cross-event image picker) + a
 * detail panel to manage files, the recipient link, the client-upload link and
 * retention. Recipient downloads always contain ORIGINAL files.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  Plus, Send, Link2, Download, Trash2, Upload, X, Copy, Image as ImageIcon,
  Clock, Ban, RefreshCw, Mail, Paperclip, FileText,
} from 'lucide-react';

import { Button, Input, Card, CardContent, Loading, useConfirm } from '../../../components/common';
import { AdminAuthenticatedImage } from '../../../components/admin/AdminAuthenticatedImage';
import { TransferPhotoPicker, type PickedPhoto } from '../../../components/admin/TransferPhotoPicker';
import { useMutationWithToast } from '../../../hooks/useMutationWithToast';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { transfersService } from '../../../services/transfers.service';

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function recipientUrl(token: string): string {
  return `${window.location.origin}/transfer/${token}`;
}
function uploadUrl(uploadToken: string): string {
  return `${window.location.origin}/transfer-upload/${uploadToken}`;
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  expired: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300',
  deleted: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

export const TransfersPage: React.FC = () => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { formatDateTime } = useLocalizedDate();
  const fmtDate = (d: string | null) => (d ? formatDateTime(d) : '—');
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: transfers, isLoading, refetch } = useQuery({
    queryKey: ['admin-transfers'],
    queryFn: () => transfersService.list(),
  });

  const copyLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('transfers.linkCopied', 'Link copied to clipboard'));
    } catch {
      toast.error(t('transfers.copyFailed', 'Could not copy link'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            <Send className="h-6 w-6" /> {t('transfers.title', 'PicTransfer')}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {t('transfers.subtitle', 'Send original files from any event as a download link.')}
          </p>
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowCreate(true)}>
          {t('transfers.new', 'New transfer')}
        </Button>
      </div>

      {isLoading ? (
        <Loading />
      ) : !transfers || transfers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-neutral-500">
            <Send className="mx-auto mb-3 h-10 w-10 text-neutral-300" />
            <p>{t('transfers.empty', 'No transfers yet. Create one to share files.')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-700">
                  <th className="px-4 py-3 font-medium">{t('transfers.col.title', 'Title')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.files', 'Files')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.status', 'Status')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.downloads', 'Downloads')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.expires', 'Expires')}</th>
                  <th className="px-4 py-3 font-medium">{t('transfers.col.uploads', 'Uploads')}</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((tr) => (
                  <tr
                    key={tr.id}
                    className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
                    onClick={() => setDetailId(tr.id)}
                  >
                    <td className="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-100">
                      {tr.title || t('transfers.untitled', 'Untitled transfer')}
                    </td>
                    <td className="px-4 py-3">{tr.file_count}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[tr.status] || ''}`}>
                        {t(`transfers.status.${tr.status}`, tr.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {tr.download_count}{tr.max_downloads ? ` / ${tr.max_downloads}` : ''}
                    </td>
                    <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{fmtDate(tr.expires_at)}</td>
                    <td className="px-4 py-3">{tr.allow_uploads ? tr.upload_count : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {showCreate && (
        <CreateTransferModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refetch(); }}
        />
      )}
      {detailId !== null && (
        <TransferDetailModal
          transferId={detailId}
          onClose={() => { setDetailId(null); refetch(); }}
          onCopy={copyLink}
          confirm={confirm}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

const CreateTransferModal: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('14');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [allowUploads, setAllowUploads] = useState(false);
  const [picked, setPicked] = useState<PickedPhoto[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [deliveryMethod, setDeliveryMethod] = useState<'link' | 'email'>('link');
  const [emails, setEmails] = useState('');

  // Split the free-text recipient field on comma / semicolon / whitespace and
  // keep only well-formed addresses. Used both to send and to gate the button.
  const parsedEmails = emails
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  const createMutation = useMutationWithToast({
    mutationFn: () => transfersService.create({
      title: title.trim(),
      message: message.trim() || null,
      expiresInDays: parseInt(expiresInDays, 10) || 14,
      maxDownloads: maxDownloads ? parseInt(maxDownloads, 10) : null,
      allowUploads,
      photoIds: picked.map((p) => p.id),
      files,
      deliveryMethod,
      recipientEmails: deliveryMethod === 'email' ? parsedEmails : [],
    }),
    successMessage: t('transfers.created', 'Transfer created'),
    errorMessage: t('transfers.createFailed', 'Could not create transfer'),
    onSuccess: onCreated,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-700">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('transfers.new', 'New transfer')}</h2>
          <button onClick={onClose} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-5 w-5" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <Input label={t('transfers.field.title', 'Title')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('transfers.field.titlePlaceholder', 'e.g. Wedding finals for the Smiths')} />
          <div>
            <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('transfers.field.message', 'Message (optional)')}</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-800"
              placeholder={t('transfers.field.messagePlaceholder', 'Shown to the recipient on the download page')}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input type="number" min={1} label={t('transfers.field.expiresInDays', 'Link active for (days)')} value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
            <Input type="number" min={0} label={t('transfers.field.maxDownloads', 'Max downloads (0 = unlimited)')} value={maxDownloads} onChange={(e) => setMaxDownloads(e.target.value)} placeholder="0" />
          </div>
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input type="checkbox" checked={allowUploads} onChange={(e) => setAllowUploads(e.target.checked)} className="rounded" />
            {t('transfers.field.allowUploads', 'Also give the client an upload link (to send logos etc.)')}
          </label>

          {/* Picker entry + selection preview */}
          <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-700">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {t('transfers.field.files', 'Files')} · {picked.length}
              </span>
              <Button size="sm" variant="outline" leftIcon={<ImageIcon className="h-4 w-4" />} onClick={() => setShowPicker(true)}>
                {t('transfers.picker.title', 'Select images from other events')}
              </Button>
            </div>
            {picked.length === 0 ? (
              <p className="text-sm text-neutral-400">{t('transfers.field.noFiles', 'No images selected yet.')}</p>
            ) : (
              <div className="grid grid-cols-6 gap-2">
                {picked.slice(0, 18).map((p) => (
                  <div key={p.id} className="relative aspect-square overflow-hidden rounded">
                    {p.thumbnail_url ? (
                      <AdminAuthenticatedImage src={p.thumbnail_url} alt={p.filename} className="h-full w-full object-cover" />
                    ) : <div className="h-full w-full bg-neutral-100 dark:bg-neutral-800" />}
                    <button
                      onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                      className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                    ><X className="h-3 w-3" /></button>
                  </div>
                ))}
                {picked.length > 18 && (
                  <div className="flex aspect-square items-center justify-center rounded bg-neutral-100 text-xs text-neutral-500 dark:bg-neutral-800">
                    +{picked.length - 18}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Upload your own files (deliverables not tied to an event) */}
          <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-700">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {t('transfers.field.uploadFiles', 'Upload your own files')} · {files.length}
              </span>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800">
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
              <p className="text-sm text-neutral-400">{t('transfers.field.noUploadFiles', 'Optionally add files from your computer to send along.')}</p>
            ) : (
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {files.map((f, idx) => (
                  <li key={`${f.name}-${idx}`} className="flex items-center justify-between py-1.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-neutral-400" />
                      <span className="truncate text-neutral-700 dark:text-neutral-300">{f.name}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                      className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-700"
                    ><X className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Delivery: copy a link yourself, or email it to recipients */}
          <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-700">
            <span className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
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
                <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('transfers.field.recipients', 'Recipient email addresses')}
                </label>
                <textarea
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-800"
                  placeholder={t('transfers.field.recipientsPlaceholder', 'anna@example.com, ben@example.com')}
                />
                <p className="mt-1 text-xs text-neutral-400">
                  {parsedEmails.length > 0
                    ? t('transfers.field.recipientsCount', '{{count}} recipient(s) — each gets the download link', { count: parsedEmails.length })
                    : t('transfers.field.recipientsHint', 'Separate multiple addresses with commas. Each recipient gets the download link.')}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-700">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button
            onClick={() => createMutation.mutate()}
            isLoading={createMutation.isPending}
            disabled={
              (picked.length === 0 && files.length === 0 && !allowUploads)
              || (deliveryMethod === 'email' && parsedEmails.length === 0)
            }
          >
            {deliveryMethod === 'email'
              ? t('transfers.createAndSend', 'Create & send')
              : t('transfers.create', 'Create transfer')}
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
}

const TransferDetailModal: React.FC<DetailProps> = ({ transferId, onClose, onCopy, confirm }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const fmtDate = (d: string | null) => (d ? formatDateTime(d) : '—');
  const [showPicker, setShowPicker] = useState(false);

  const { data: transfer, isLoading, refetch } = useQuery({
    queryKey: ['admin-transfer', transferId],
    queryFn: () => transfersService.get(transferId),
  });

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
    successMessage: t('transfers.disabled', 'Link disabled'),
    onSuccess: () => refetch(),
  });
  const reactivateMutation = useMutationWithToast({
    mutationFn: () => transfersService.update(transferId, { isActive: true, expiresInDays: 14 }),
    successMessage: t('transfers.reactivated', 'Link re-activated'),
    onSuccess: () => refetch(),
  });
  const enableUploadsMutation = useMutationWithToast({
    mutationFn: () => transfersService.enableUploads(transferId),
    successMessage: t('transfers.uploadEnabled', 'Upload link enabled'),
    onSuccess: () => refetch(),
  });
  const disableUploadsMutation = useMutationWithToast({
    mutationFn: () => transfersService.disableUploads(transferId),
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
    onSuccess: () => refetch(),
  });
  const removeExtraFileMutation = useMutationWithToast({
    mutationFn: (extraId: number) => transfersService.removeExtraFile(transferId, extraId),
    onSuccess: () => refetch(),
  });

  const handleDelete = async () => {
    const ok = await confirm({
      title: t('transfers.deleteConfirmTitle', 'Delete transfer?'),
      message: t('transfers.deleteConfirmBody', 'This removes the link and any client uploads. Source event photos are not affected.'),
      variant: 'danger',
    });
    if (ok) deleteMutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-700">
          <h2 className="truncate text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {transfer?.title || t('transfers.untitled', 'Untitled transfer')}
          </h2>
          <button onClick={onClose} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-5 w-5" /></button>
        </div>

        {isLoading || !transfer ? (
          <div className="p-8"><Loading /></div>
        ) : (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {/* Prominent recipient link + download-all, up top */}
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800/50">
              <div className="flex flex-wrap items-center gap-2">
                <Input readOnly value={recipientUrl(transfer.token)} className="flex-1 min-w-[220px]" />
                <Button variant="outline" leftIcon={<Copy className="h-4 w-4" />} onClick={() => onCopy(recipientUrl(transfer.token))}>
                  {t('transfers.copyLink', 'Copy link')}
                </Button>
                <a href={transfersService.adminDownloadUrl(transfer.id)}>
                  <Button leftIcon={<Download className="h-4 w-4" />}>{t('transfers.downloadAll', 'Download all')}</Button>
                </a>
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-sm text-neutral-600 dark:text-neutral-400">
                <span className="flex items-center gap-1"><Clock className="h-4 w-4" /> {t('transfers.expiresOn', 'Expires')}: {fmtDate(transfer.expires_at)}</span>
                <span>{t('transfers.col.downloads', 'Downloads')}: {transfer.download_count}{transfer.max_downloads ? ` / ${transfer.max_downloads}` : ''}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[transfer.status] || ''}`}>{t(`transfers.status.${transfer.status}`, transfer.status)}</span>
              </div>
              <div className="mt-3 flex gap-2">
                {transfer.is_active ? (
                  <Button size="sm" variant="outline" leftIcon={<Ban className="h-4 w-4" />} onClick={() => disableMutation.mutate()} isLoading={disableMutation.isPending}>
                    {t('transfers.disableLink', 'Disable link')}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={() => reactivateMutation.mutate()} isLoading={reactivateMutation.isPending}>
                    {t('transfers.reactivate', 'Re-activate (14 days)')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-red-600" leftIcon={<Trash2 className="h-4 w-4" />} onClick={handleDelete}>
                  {t('common.delete', 'Delete')}
                </Button>
              </div>
            </div>

            {/* Files */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t('transfers.field.files', 'Files')} · {transfer.file_count}</h3>
                <Button size="sm" variant="outline" leftIcon={<ImageIcon className="h-4 w-4" />} onClick={() => setShowPicker(true)}>
                  {t('transfers.addImages', 'Add images')}
                </Button>
              </div>
              {transfer.files && transfer.files.length > 0 ? (
                <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
                  {transfer.files.map((f) => (
                    <div key={f.file_id} className="group relative aspect-square overflow-hidden rounded">
                      <AdminAuthenticatedImage src={f.thumbnail_url} alt={f.filename} className="h-full w-full object-cover" />
                      <button
                        onClick={() => removeFileMutation.mutate(f.file_id)}
                        className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition group-hover:opacity-100"
                        title={t('common.remove', 'Remove')}
                      ><X className="h-3 w-3" /></button>
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 py-0.5 text-[10px] text-white" title={f.event_name}>{f.event_name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-neutral-400">{t('transfers.field.noFiles', 'No images selected yet.')}</p>
              )}
            </div>

            {/* Admin-uploaded deliverable files */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  <Paperclip className="h-4 w-4" /> {t('transfers.uploadedFiles', 'Uploaded files')} · {transfer.extra_files?.length || 0}
                </h3>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800">
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
              </div>
              {transfer.extra_files && transfer.extra_files.length > 0 ? (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {transfer.extra_files.map((f) => (
                    <li key={f.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-neutral-400" />
                        <span className="truncate text-neutral-700 dark:text-neutral-300">{f.filename}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 text-neutral-500">
                        <span>{formatBytes(f.size_bytes)}</span>
                        <a href={transfersService.adminExtraFileDownloadUrl(transferId, f.id)} className="text-primary-600 hover:underline">
                          <Download className="h-4 w-4" />
                        </a>
                        <button
                          onClick={() => removeExtraFileMutation.mutate(f.id)}
                          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-700"
                          title={t('common.remove', 'Remove')}
                        ><X className="h-3.5 w-3.5" /></button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-neutral-400">{t('transfers.noUploadedFiles', 'No uploaded files. Add files from your computer to include them in the download.')}</p>
              )}
            </div>

            {/* Email recipients (when delivered by email) */}
            {transfer.recipients && transfer.recipients.length > 0 && (
              <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  <Mail className="h-4 w-4" /> {t('transfers.sentTo', 'Emailed to')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {transfer.recipients.map((r) => (
                    <span key={r.id} className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                      {r.email}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Client uploads */}
            <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  <Upload className="h-4 w-4" /> {t('transfers.clientUpload', 'Client upload')}
                </h3>
                {transfer.allow_uploads ? (
                  <Button size="sm" variant="ghost" className="text-red-600" onClick={() => disableUploadsMutation.mutate()}>
                    {t('transfers.disableUploads', 'Disable')}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => enableUploadsMutation.mutate()} isLoading={enableUploadsMutation.isPending}>
                    {t('transfers.enableUploads', 'Enable upload link')}
                  </Button>
                )}
              </div>
              {transfer.allow_uploads && transfer.upload_token ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="rounded bg-neutral-100 px-3 py-1.5 font-mono text-lg tracking-widest dark:bg-neutral-800">{transfer.upload_token}</div>
                    <Input readOnly value={uploadUrl(transfer.upload_token)} className="flex-1 min-w-[200px]" />
                    <Button variant="outline" size="sm" leftIcon={<Copy className="h-4 w-4" />} onClick={() => onCopy(uploadUrl(transfer.upload_token as string))}>
                      {t('transfers.copyLink', 'Copy link')}
                    </Button>
                  </div>
                  {transfer.uploads && transfer.uploads.length > 0 ? (
                    <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800">
                      {transfer.uploads.map((u) => (
                        <li key={u.id} className="flex items-center justify-between py-2 text-sm">
                          <span className="truncate">{u.original_filename}</span>
                          <span className="flex items-center gap-3 text-neutral-500">
                            <span>{formatBytes(u.size_bytes)}</span>
                            <a href={transfersService.adminUploadDownloadUrl(transferId, u.id)} className="text-primary-600 hover:underline">
                              <Download className="h-4 w-4" />
                            </a>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-neutral-400">{t('transfers.noUploads', 'No files uploaded by the client yet.')}</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-neutral-400">
                  {t('transfers.uploadHint', 'Enable this to give the client a 6-character code to send you files (logos etc.).')}
                </p>
              )}
            </div>
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
