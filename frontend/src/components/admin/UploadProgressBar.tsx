import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Cog, Upload, X } from 'lucide-react';
import { useUploadSession } from '../../contexts/UploadSessionContext';

// Sits under the admin header for the life of an upload session: transfer
// progress, then processing progress, then the outcome. Failures list every
// file with its reason and stay until dismissed; a clean finish clears itself.
export const UploadProgressBar: React.FC = () => {
  const { t } = useTranslation();
  const { session, dismiss } = useUploadSession();
  const { pathname } = useLocation();

  if (!session) return null;

  const eventPath = `/admin/events/${session.eventId}`;
  const onEventPage = pathname === eventPath || pathname.startsWith(`${eventPath}/`);
  const { phase } = session;
  const hasFailures = session.failures.length > 0;

  const processingPct =
    session.processing.total === 0
      ? 0
      : Math.round(((session.processing.complete + session.processing.failed) / session.processing.total) * 100);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="upload-progress-bar"
      className={clsx(
        'sticky top-16 z-20 border-b px-4 sm:px-6 lg:px-8 py-2.5 text-sm',
        phase.kind === 'done' && hasFailures
          ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/60'
          : 'bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-700'
      )}
    >
      <div className="flex items-center gap-3">
        {phase.kind === 'transferring' && <Upload className="w-4 h-4 text-accent-dark flex-shrink-0" />}
        {phase.kind === 'processing' && <Cog className="w-4 h-4 text-amber-600 dark:text-amber-400 animate-spin flex-shrink-0" />}
        {phase.kind === 'done' && !hasFailures && <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />}
        {phase.kind === 'done' && hasFailures && <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 flex-shrink-0" />}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate font-medium text-neutral-800 dark:text-neutral-100">
              {phase.kind === 'transferring' && (
                <>
                  {t('upload.bar.uploading', { count: session.fileCount })}
                  {session.totalChunks > 1 && (
                    <span className="font-normal text-neutral-500 dark:text-neutral-400">
                      {` (${t('common.chunk')} ${session.currentChunk}/${session.totalChunks})`}
                    </span>
                  )}
                </>
              )}
              {phase.kind === 'processing' && (
                <>
                  {t('upload.processing')}
                  {session.processing.total > 0 && (
                    <span className="font-normal text-neutral-500 dark:text-neutral-400">
                      {` · ${t('upload.processingProgress', {
                        complete: session.processing.complete + session.processing.failed,
                        total: session.processing.total,
                      })}`}
                    </span>
                  )}
                </>
              )}
              {phase.kind === 'done' && !hasFailures && t('upload.bar.uploaded', { count: session.uploadedCount })}
              {phase.kind === 'done' && hasFailures && (
                <>
                  {t('upload.failures.title', { count: session.failures.length })}
                  {session.uploadedCount > 0 && (
                    <span className="font-normal text-neutral-600 dark:text-neutral-300">
                      {` · ${t('upload.bar.uploaded', { count: session.uploadedCount })}`}
                    </span>
                  )}
                </>
              )}
            </p>
            <div className="flex items-center gap-3 flex-shrink-0">
              {!onEventPage && (
                <Link to={eventPath} className="text-accent-dark hover:underline whitespace-nowrap">
                  {t('upload.bar.viewEvent', 'View event')}
                </Link>
              )}
              {phase.kind === 'transferring' && (
                <span className="tabular-nums text-neutral-600 dark:text-neutral-400">{session.progress}%</span>
              )}
              {phase.kind === 'done' && (
                <button
                  type="button"
                  onClick={dismiss}
                  aria-label={t('common.dismiss', 'Dismiss')}
                  className="p-1 -m-1 rounded text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {phase.kind !== 'done' && (
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
              <div
                className={clsx(
                  'h-full rounded-full transition-all duration-300',
                  phase.kind === 'processing' ? 'bg-amber-500' : 'bg-accent-dark'
                )}
                style={{ width: `${phase.kind === 'processing' ? processingPct : session.progress}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Failure report — names every file that didn't make it into the
          gallery, grouped by failure stage, so the user can act on each.
          Transfer failures are final before processing ends, so the list
          shows as soon as there is one. */}
      {hasFailures && (
        <ul data-testid="upload-failure-report" className="mt-2 ml-7 max-h-48 overflow-y-auto space-y-1.5">
          {session.failures.map((f, i) => (
            <li key={`${f.kind}-${f.filename}-${i}`} className="flex items-start gap-2 text-xs">
              <span
                className={clsx(
                  'flex-shrink-0 mt-0.5 px-1.5 py-0.5 rounded font-medium whitespace-nowrap',
                  f.kind === 'rejected' && 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
                  f.kind === 'transfer' && 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
                  f.kind === 'processing' && 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
                )}
              >
                {f.kind === 'rejected' && t('upload.failures.kindRejected', 'Rejected')}
                {f.kind === 'transfer' && t('upload.failures.kindTransfer', 'Transfer failed')}
                {f.kind === 'processing' && t('upload.failures.kindProcessing', 'Processing failed')}
              </span>
              <span className="min-w-0">
                <span className="font-medium text-neutral-800 dark:text-neutral-200 break-all">{f.filename}</span>
                <span className="text-neutral-500 dark:text-neutral-400"> — {f.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

UploadProgressBar.displayName = 'UploadProgressBar';
