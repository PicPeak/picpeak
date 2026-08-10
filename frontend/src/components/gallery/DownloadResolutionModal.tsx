import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Check, AlertCircle, X, Loader2 } from 'lucide-react';

import { Button, Card } from '../common';
import { galleryService } from '../../services/gallery.service';
import type { DownloadResolutionChoice, DownloadJobStatus } from '../../types';

/**
 * Resolution picker for gallery downloads (#858).
 *
 * Shown after "Download all"/"Download selected" when the gallery has the
 * picker enabled. A non-standard size has nothing cached behind it and can
 * take minutes to build, so the server prepares it as a job and this modal
 * walks the three states the build actually has:
 *
 *   choose → preparing (poll) → ready (click to download)
 *
 * The download itself is a native browser navigation, so the archive streams
 * with Content-Length and the browser shows a real progress bar rather than
 * us buffering a multi-GB blob in memory.
 */

const POLL_MS = 1500;
// Give up after ~10 minutes of polling. The job may well still finish server
// side; this only stops the modal spinning forever in front of the user.
const MAX_POLLS = (10 * 60 * 1000) / POLL_MS;

type Phase = 'choose' | 'preparing' | 'ready' | 'error';

interface DownloadResolutionModalProps {
  slug: string;
  choices: DownloadResolutionChoice[];
  /** The gallery's own standard size — served from the pre-built archive. */
  standardResolution?: string;
  /** Omitted = the whole gallery. */
  photoIds?: number[];
  onClose: () => void;
}

export const DownloadResolutionModal: React.FC<DownloadResolutionModalProps> = ({
  slug,
  choices,
  standardResolution,
  photoIds,
  onClose,
}) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('choose');
  const [selected, setSelected] = useState<string>(choices[0]?.id ?? 'original');
  const [error, setError] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState(0);
  const tokenRef = useRef<string | null>(null);
  // Guards the polling loop against running on after unmount / close.
  const activeRef = useRef(true);

  useEffect(() => () => { activeRef.current = false; }, []);

  const filename = `${slug}-${selected === 'original' ? 'original' : selected}.zip`;

  const poll = useCallback(async (token: string) => {
    for (let i = 0; i < MAX_POLLS; i += 1) {
      if (!activeRef.current) return;
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!activeRef.current) return;
      try {
        const state = await galleryService.getDownloadJob(slug, token);
        setPhotoCount(state.photo_count || 0);
        if (state.status === 'ready') {
          setPhase('ready');
          return;
        }
        if (state.status === 'failed') {
          setError(state.error || t('gallery.downloadPrepFailed', 'Preparation failed'));
          setPhase('error');
          return;
        }
      } catch {
        setError(t('gallery.downloadPrepFailed', 'Preparation failed'));
        setPhase('error');
        return;
      }
    }
    setError(t('gallery.downloadPrepTimeout', 'This is taking longer than expected. Please try again.'));
    setPhase('error');
  }, [slug, t]);

  const start = useCallback(async () => {
    // Whole-gallery download at the gallery's OWN standard size is exactly
    // what the pre-built archive already contains — take it instead of
    // re-resizing and re-packaging the entire gallery for the same bytes.
    if (!photoIds && selected === standardResolution) {
      await galleryService.downloadAllPhotos(slug, true);
      onClose();
      return;
    }

    setPhase('preparing');
    setError(null);
    try {
      const job = await galleryService.startDownloadJob(slug, selected, photoIds);
      tokenRef.current = job.token;
      // A job can be deduped onto an already-finished build, in which case
      // there is nothing to wait for.
      if ((job.status as DownloadJobStatus) === 'ready') {
        setPhase('ready');
        return;
      }
      await poll(job.token);
    } catch {
      setError(t('gallery.downloadPrepFailed', 'Preparation failed'));
      setPhase('error');
    }
  }, [slug, selected, photoIds, poll, t, standardResolution, onClose]);

  const download = useCallback(() => {
    if (!tokenRef.current) return;
    galleryService.downloadJobFile(slug, tokenRef.current, filename);
    onClose();
  }, [slug, filename, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('gallery.chooseResolution', 'Choose a download size')}
    >
      <Card
        className="max-w-md w-full"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('gallery.chooseResolution', 'Choose a download size')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {phase === 'choose' && (
          <>
            <div className="space-y-2 mb-5">
              {choices.map((choice) => (
                <label
                  key={choice.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selected === choice.id
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="download-resolution"
                    value={choice.id}
                    checked={selected === choice.id}
                    onChange={() => setSelected(choice.id)}
                    className="accent-primary-600"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {choice.label}
                    </span>
                    {choice.width && choice.height && (
                      <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                        {t('gallery.resolutionUpTo', 'up to {{width}} × {{height}} px', {
                          width: choice.width,
                          height: choice.height,
                        })}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" onClick={start} leftIcon={<Download className="w-4 h-4" />}>
                {t('gallery.prepareDownload', 'Prepare download')}
              </Button>
            </div>
          </>
        )}

        {phase === 'preparing' && (
          <div className="py-6 text-center">
            <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin text-primary-600" />
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('gallery.preparingDownload', 'Preparing your download…')}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {photoCount > 0
                ? t('gallery.preparingProgress', '{{count}} photos packaged', { count: photoCount })
                : t('gallery.preparingHint', 'Resizing photos — this can take a moment for large galleries.')}
            </p>
          </div>
        )}

        {phase === 'ready' && (
          <div className="py-6 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <Check className="w-6 h-6 text-green-600 dark:text-green-400" />
            </div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-4">
              {t('gallery.downloadReady', 'Your download is ready')}
            </p>
            <Button variant="primary" onClick={download} leftIcon={<Download className="w-4 h-4" />}>
              {t('gallery.downloadNow', 'Download')}
            </Button>
          </div>
        )}

        {phase === 'error' && (
          <div className="py-6 text-center">
            <AlertCircle className="w-8 h-8 mx-auto mb-3 text-red-600 dark:text-red-400" />
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-4">{error}</p>
            <div className="flex justify-center gap-2">
              <Button variant="outline" onClick={onClose}>
                {t('common.close', 'Close')}
              </Button>
              <Button variant="primary" onClick={() => setPhase('choose')}>
                {t('common.retry', 'Try again')}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};
