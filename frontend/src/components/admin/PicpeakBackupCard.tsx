import React, { useRef, useState } from 'react';
import { Download, Upload, AlertTriangle, ShieldAlert, ExternalLink, CheckCircle2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Card } from '../common';
import { api } from '../../config/api';

// Portable ".picpeak" roundtrip, split across two Backup Manager tabs:
//   - PicpeakExportCard  → Dashboard (making a backup)
//   - PicpeakRestoreCard → Restore   (restoring a backup)
// The manifest is bundled inside the .picpeak, so there is no separate
// "manifest only" download here.

interface RestoreResult {
  tables: number;
  filesRestored: number;
  usesExternalMedia: boolean;
}

// ── Download half (Dashboard) ────────────────────────────────────────────────
export const PicpeakExportCard: React.FC = () => {
  const { t } = useTranslation();
  const [includePhotos, setIncludePhotos] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await api.get('/admin/backup/picpeak/export', {
        params: { includePhotos },
        responseType: 'blob',
      });
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
    } catch (_) {
      toast.error(t('backup.picpeak.downloadFailed', 'Could not create the backup file.'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card padding="lg">
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t('backup.picpeak.title', 'Portable backup (.picpeak)')}
      </h3>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t('backup.picpeak.intro', 'Download a single self-contained file, then upload it on another instance to clone this one — all through the browser.')}
      </p>

      <div className="mt-6">
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-neutral-300"
            checked={includePhotos}
            onChange={(e) => setIncludePhotos(e.target.checked)}
          />
          {t('backup.picpeak.includePhotos', 'Include original gallery photos (larger file)')}
        </label>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-900/20">
          <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-amber-800 dark:text-amber-200">
            {t('backup.picpeak.secretsWarning', 'This file contains secrets in plain text (email password, admin credentials, API keys). Store it securely and only transfer it over trusted channels.')}
          </p>
        </div>
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
  const [result, setResult] = useState<RestoreResult | null>(null);

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setPendingFile(f);
    e.target.value = ''; // let the user re-pick the same file after cancelling
  };

  const confirmRestore = async () => {
    if (!pendingFile) return;
    setRestoring(true);
    try {
      const fd = new FormData();
      fd.append('backup', pendingFile);
      const res = await api.post<RestoreResult>('/admin/backup/picpeak/import', fd);
      setResult(res.data);
      setPendingFile(null);
      toast.success(t('backup.picpeak.restoreDone', 'Backup restored.'));
    } catch (e: any) {
      const msg = e.response?.data?.error || t('backup.picpeak.restoreFailed', 'Restore failed.');
      toast.error(msg);
      setPendingFile(null);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Card padding="lg">
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t('backup.picpeak.restoreTitle', 'Restore from a .picpeak')}
      </h3>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {t('backup.picpeak.restoreIntro', 'Upload a .picpeak taken from this or another instance. Same database engine only.')}
      </p>
      <input ref={fileRef} type="file" accept=".picpeak,application/zip" className="hidden" onChange={onFilePick} />
      <Button
        variant="outline"
        className="mt-4"
        onClick={() => fileRef.current?.click()}
        leftIcon={<Upload className="h-4 w-4" />}
      >
        {t('backup.picpeak.chooseFile', 'Choose .picpeak file…')}
      </Button>

      {result && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900/50 dark:bg-green-900/20">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-green-800 dark:text-green-200">
                {t('backup.picpeak.restoreDone', 'Backup restored.')}
              </p>
              <p className="mt-0.5 text-xs text-green-700 dark:text-green-300">
                {t('backup.picpeak.restoreSummary', '{{tables}} tables and {{files}} files restored.', {
                  tables: result.tables,
                  files: result.filesRestored,
                })}
              </p>
              {result.usesExternalMedia && (
                <p className="mt-2 flex items-start gap-1 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>
                    {t('backup.picpeak.externalMediaNote', 'This backup references an external-media library. Make sure external-media routing is configured on this instance.')}{' '}
                    <a
                      href="https://github.com/PicPeak/picpeak/blob/main/README.md"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 underline"
                    >
                      {t('backup.picpeak.externalMediaLink', 'Setup guide')}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </span>
                </p>
              )}
              <Button variant="primary" size="sm" className="mt-3" onClick={() => window.location.reload()}>
                {t('backup.picpeak.reload', 'Reload app')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Destructive confirmation */}
      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-neutral-800">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-6 w-6 flex-shrink-0 text-red-600 dark:text-red-400" />
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('backup.picpeak.confirmTitle', 'Restore will delete all current data')}
                </h3>
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
                  {t('backup.picpeak.confirmBody', 'This permanently replaces ALL data on this instance with the uploaded backup, except your current account. This cannot be undone.')}
                </p>
                <p className="mt-2 truncate text-xs text-neutral-500 dark:text-neutral-400">{pendingFile.name}</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" onClick={() => setPendingFile(null)} disabled={restoring}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                className="!bg-red-600 hover:!bg-red-700"
                isLoading={restoring}
                onClick={confirmRestore}
              >
                {t('backup.picpeak.confirmRestore', 'Delete & restore')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};

PicpeakRestoreCard.displayName = 'PicpeakRestoreCard';
