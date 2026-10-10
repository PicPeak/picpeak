import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../common';
import { clearRestoreHandle, portableBackupService, type RestoreHandle, type RestoreProgress } from '../../services/portableBackup.service';

// The only surviving capability is read-only and bound to one admitted
// attempt. This panel does not depend on an admin session that the worker
// deliberately invalidates. A restore that failed leaves the instance running
// with its previous data; the panel says why and lets the admin carry on.
export function PortableRestoreProgress({ handle }: { handle: RestoreHandle }) {
  const { attemptId, progressToken } = handle;
  const { t } = useTranslation();
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    setProgress(null); setUnavailable(false); setDenied(false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const current = await portableBackupService.progress({ attemptId, progressToken }, controller.signal);
        if (controller.signal.aborted) return;
        setProgress(current); setUnavailable(false);
        if (!current.complete) timer = setTimeout(poll, 1500);
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        const status = (error as { response?: { status: number } }).response?.status;
        if (status === 404) { setDenied(true); return; }
        setUnavailable(true);
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attemptId, progressToken]);

  const leave = () => { clearRestoreHandle(); window.location.href = '/admin/login'; };
  // After a rollback or an aborted restore the session is still valid.
  const resume = () => { clearRestoreHandle(); window.location.reload(); };
  const failed = progress?.outcome === 'rolled_back' || progress?.outcome === 'aborted';
  const failure = progress?.error
    ? t(`backup.picpeak.restoreError.${progress.error.code}`, { defaultValue: progress.error.message })
    : null;
  return <main className="mx-auto max-w-2xl p-6" aria-live="polite">
    <Card padding="lg">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('backup.picpeak.coordinatedTitle')}</h1>
      <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.coordinatedIntro')}</p>
      {progress && <p className="mt-4 font-medium text-neutral-900 dark:text-neutral-100">{t(`backup.picpeak.restoreState.${progress.state}`)}</p>}
      {!progress && !denied && <p className="mt-4 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.awaitingProgress')}</p>}
      {unavailable && <p className="mt-4 text-neutral-600 dark:text-neutral-400">{t('backup.picpeak.progressUnavailable')}</p>}
      {progress?.restartRequired && <p className="mt-4 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.restartAllInstances')}</p>}
      {progress?.outcome === 'committed' && <p className="mt-4 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.restoreSummary', {
        tables: progress.summary.tables ?? 0, files: progress.summary.filesRestored ?? 0,
      })}</p>}
      {progress?.summary.crossEngine && <p className="mt-2 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.crossEngineNote')}</p>}
      {progress?.summary.usesExternalMedia && <p className="mt-2 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.externalMediaNote')}</p>}
      {progress?.outcome === 'rolled_back' && <p className="mt-4 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.rollbackVerified')}</p>}
      {progress?.outcome === 'aborted' && <p className="mt-4 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.restoreAborted')}</p>}
      {progress?.state === 'recovery_required' && <p className="mt-4 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.recoveryRequired')}</p>}
      {failure && <p className="mt-2 text-neutral-700 dark:text-neutral-300" role="alert">{t('backup.picpeak.failureReason', { reason: failure })}</p>}
      {denied && <p className="mt-4 text-neutral-700 dark:text-neutral-300">{t('backup.picpeak.progressDenied')}</p>}
      {progress?.complete && failed && <Button className="mt-4" onClick={resume}>{t('backup.picpeak.backToBackup')}</Button>}
      {((progress?.complete && !failed) || denied) && <Button className="mt-4" onClick={leave}>{t('backup.picpeak.returnToLogin')}</Button>}
    </Card>
  </main>;
}
