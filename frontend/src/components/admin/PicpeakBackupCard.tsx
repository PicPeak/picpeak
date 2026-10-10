import React, { useRef, useState } from 'react';
import { Download, Upload, ShieldAlert, Info } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import { Button, Card, Modal, Notice } from '../common';
import { portableBackupService } from '../../services/portableBackup.service';

// Portable ".picpeak" roundtrip, split across two Backup Manager tabs:
//   - PicpeakExportCard  → Dashboard (making a backup)
//   - PicpeakRestoreCard → Restore   (restoring a backup)
// The manifest is bundled inside the .picpeak, so there is no separate
// "manifest only" download here.


// ── Download half (Dashboard) ────────────────────────────────────────────────
export const PicpeakExportCard: React.FC = () => {
  const { t } = useTranslation();
  const [includePhotos, setIncludePhotos] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await portableBackupService.export(includePhotos);
      const cd = (res.headers['content-disposition'] as string) || '';
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = (match && match[1]) || 'picpeak-backup.picpeak';
      const url = window.URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error(t('backup.picpeak.downloadFailed', 'Could not create the backup file.'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card padding="lg">
      <h3 className="text-lg font-semibold text-heading">
        {t('backup.picpeak.title', 'Portable backup (.picpeak)')}
      </h3>
      <p className="mt-1 text-sm text-soft">
        {t('backup.picpeak.intro', 'Download a single self-contained file, then upload it on another instance to clone this one — all through the browser.')}
      </p>

      <div className="mt-6">
        <label className="flex items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line-strong"
            checked={includePhotos}
            onChange={(e) => setIncludePhotos(e.target.checked)}
          />
          {t('backup.picpeak.includePhotos', 'Include original gallery photos (larger file)')}
        </label>
        <Notice tone="warning" size="sm" className="mt-3" icon={<ShieldAlert className="h-4 w-4" />}>
          {t('backup.picpeak.secretsWarning', 'This file contains secrets in plain text (email password, admin credentials, API keys). Store it securely and only transfer it over trusted channels.')}
        </Notice>
        <Button
          variant="outline"
          className="mt-3"
          isLoading={downloading}
          onClick={handleDownload}
          leftIcon={<Download className="h-4 w-4" />}
        >
          {t('backup.picpeak.download', 'Download .picpeak')}
        </Button>
      </div>
    </Card>
  );
};

PicpeakExportCard.displayName = 'PicpeakExportCard';

// ── Restore half (Restore tab) ───────────────────────────────────────────────
export const PicpeakRestoreCard: React.FC = () => {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Not every server can run a restore (it needs Linux, the native build and
  // local storage). Where it cannot, say so here instead of failing an upload.
  const { data: capability } = useQuery({
    queryKey: ['picpeak-restore-capability'],
    queryFn: () => portableBackupService.capability(),
    staleTime: 60_000,
    retry: false,
  });
  const unavailable = capability?.available === false;

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setPendingFile(f);
    e.target.value = ''; // let the user re-pick the same file after cancelling
  };

  const confirmRestore = async () => {
    if (!pendingFile) return;
    setRestoring(true);
    try {
      await portableBackupService.start(pendingFile);
      setPendingFile(null);
    } catch (e: any) {
      // The server validates the file before it changes anything; its refusal
      // names the reason by code, with its own text as the fallback.
      const code = e.response?.data?.code as string | undefined;
      const reason = code
        ? t(`backup.picpeak.restoreError.${code}`, { defaultValue: t(`backup.picpeak.unavailable.${code}`, { defaultValue: e.response?.data?.error || '' }) })
        : (e.response?.data?.error || '');
      toast.error([t('backup.picpeak.restoreNotStarted', 'The restore was not started. Nothing was changed.'), reason].filter(Boolean).join(' '));
      setPendingFile(null);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Card padding="lg">
      <h3 className="text-lg font-semibold text-heading">
        {t('backup.picpeak.restoreTitle', 'Restore from a .picpeak')}
      </h3>
      <p className="mt-1 text-sm text-soft">
        {t('backup.picpeak.restoreIntro', 'Upload a .picpeak taken from this or another instance. Restoring a SQLite backup onto a PostgreSQL instance is supported (the upgrade path); other engine combinations must match.')}
      </p>
      {unavailable && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-subtle p-3" role="status">
          <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-soft" />
          <div className="text-sm text-body">
            <p className="font-medium text-heading">{t('backup.picpeak.unavailableTitle', 'Restoring a .picpeak is not available on this server')}</p>
            <p className="mt-1">
              {t(`backup.picpeak.unavailable.${capability?.reason}`, { defaultValue: capability?.message || '' })}
            </p>
            <p className="mt-1 text-soft">{t('backup.picpeak.unavailableHelp', 'Everything else, including creating a .picpeak, works normally.')}</p>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".picpeak,application/zip" className="hidden" onChange={onFilePick} />
      <Button
        variant="outline"
        className="mt-4"
        disabled={unavailable}
        onClick={() => fileRef.current?.click()}
        leftIcon={<Upload className="h-4 w-4" />}
      >
        {t('backup.picpeak.chooseFile', 'Choose .picpeak file…')}
      </Button>


      {/* Destructive confirmation */}
      <Modal
        open={!!pendingFile}
        onClose={() => { if (!restoring) setPendingFile(null); }}
        closeOnBackdrop={false}
        size="sm"
        title={t('backup.picpeak.confirmTitle', 'Restore will delete all current data')}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingFile(null)} disabled={restoring}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="danger"
              isLoading={restoring}
              onClick={confirmRestore}
            >
              {t('backup.picpeak.confirmRestore', 'Delete & restore')}
            </Button>
          </>
        }
      >
        <Notice tone="danger">
          {t('backup.picpeak.confirmBody', 'This permanently replaces ALL data on this instance with the uploaded backup, except your current account. This cannot be undone.')}
        </Notice>
        <p className="mt-2 truncate text-xs text-muted">{pendingFile?.name}</p>
      </Modal>
    </Card>
  );
};

PicpeakRestoreCard.displayName = 'PicpeakRestoreCard';
