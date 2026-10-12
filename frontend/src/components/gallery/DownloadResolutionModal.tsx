import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Check, AlertCircle, X, Loader2 } from 'lucide-react';

import { Button } from '../common';
import { galleryService } from '../../services/gallery.service';
import type { DownloadResolutionChoice, DownloadJobStatus, DownloadJobPart } from '../../types';
import { formatFileSize } from '../../utils/fileSize';
import { useDownloadQuota } from '../../contexts/DownloadQuotaContext';
import {
  isDownloadLimitError, isGalleryLimited, notifyDownloadQuotaChanged, showDownloadLimitReached,
  type QuotaPhoto,
} from '../../utils/downloadLimit';
import { DownloadQuotaNotice } from './DownloadQuotaNotice';
import { useGalleryDialog } from './hooks/useGalleryDialog';

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
  /** The photos this download would ship, priced against the download limit (issue 1560). */
  quotaPhotos?: QuotaPhoto[];
  onClose: () => void;
}

export const DownloadResolutionModal: React.FC<DownloadResolutionModalProps> = ({
  slug,
  choices,
  standardResolution,
  photoIds,
  quotaPhotos,
  onClose,
}) => {
  const { t } = useTranslation();
  const downloadQuota = useDownloadQuota();
  const overQuota = !!quotaPhotos && !downloadQuota.allows(quotaPhotos);
  const [phase, setPhase] = useState<Phase>('choose');
  const [selected, setSelected] = useState<string>(choices[0]?.id ?? 'original');
  const [error, setError] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState(0);
  // A download too large for one archive arrives as several (issue 1733).
  const [parts, setParts] = useState<DownloadJobPart[]>([]);
  // The parts already handed to the browser, so the guest can tell which are left.
  const [startedParts, setStartedParts] = useState<number[]>([]);
  const tokenRef = useRef<string | null>(null);
  // Guards the polling loop against running on after unmount / close.
  const activeRef = useRef(true);

  // Set on mount as well: StrictMode runs the cleanup once in development,
  // and the ref would stay false, so the poll below never asked.
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const baseName = `${slug}-${selected === 'original' ? 'original' : selected}`;
  const filename = `${baseName}.zip`;

  const poll = useCallback(async (token: string) => {
    for (let i = 0; i < MAX_POLLS; i += 1) {
      if (!activeRef.current) return;
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!activeRef.current) return;
      try {
        const state = await galleryService.getDownloadJob(slug, token);
        setPhotoCount(state.photo_count || 0);
        if (state.status === 'ready') {
          setParts(state.parts || []);
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
      try {
        await galleryService.downloadAllPhotos(slug, true);
      } catch (err) {
        // The limit refusal already told the guest why (issue 1560).
        if (!isDownloadLimitError(err)) throw err;
      }
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
        setParts(job.parts || []);
        setPhase('ready');
        return;
      }
      await poll(job.token);
    } catch (err) {
      setError(isDownloadLimitError(err)
        ? t('gallery.downloadLimit.reached', 'Download limit reached. Please contact your photographer for more downloads.')
        : t('gallery.downloadPrepFailed', 'Preparation failed'));
      setPhase('error');
    }
  }, [slug, selected, photoIds, poll, t, standardResolution, onClose]);

  const download = useCallback(async (part?: number) => {
    const token = tokenRef.current;
    if (!token) return;
    // Download limit (issue 1560): the file is a browser navigation, which
    // cannot show why it was refused. Ask first — another viewer may have
    // used up the quota while this archive was being prepared.
    if (isGalleryLimited(slug)) {
      try {
        const state = await galleryService.getDownloadJob(slug, token);
        if (state.download_limit_reached) {
          showDownloadLimitReached(state.download_limit_reached);
          notifyDownloadQuotaChanged(slug);
          setError(t('gallery.downloadLimit.reached', 'Download limit reached. Please contact your photographer for more downloads.'));
          setPhase('error');
          return;
        }
      } catch {
        // The file route still enforces the limit; let it decide.
      }
    }
    if (part) {
      // The dialog stays open: the other parts are still to be fetched.
      galleryService.downloadJobFile(slug, token, `${baseName}-part-${part}-of-${parts.length}.zip`, part);
      setStartedParts((started) => (started.includes(part) ? started : [...started, part]));
      return;
    }
    galleryService.downloadJobFile(slug, token, filename);
    onClose();
  }, [slug, filename, baseName, parts.length, onClose, t]);

  const panelRef = useRef<HTMLDivElement>(null);
  useGalleryDialog({ open: true, onClose, panelRef });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('gallery.chooseResolution', 'Choose a download size')}
        className="card-themed text-theme p-6 max-w-md w-full"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-theme">
            {t('gallery.chooseResolution', 'Choose a download size')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="text-muted-theme hover:text-theme"
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
                      ? 'border-accent bg-accent-soft'
                      : 'border-border-token hover-surface'
                  }`}
                >
                  <input
                    type="radio"
                    name="download-resolution"
                    value={choice.id}
                    checked={selected === choice.id}
                    onChange={() => setSelected(choice.id)}
                    className="accent-accent"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-theme">
                      {choice.label}
                    </span>
                    {choice.width && choice.height && (
                      <span className="block text-xs text-muted-theme">
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
            {quotaPhotos && downloadQuota.limited && (
              <DownloadQuotaNotice photos={quotaPhotos} className="mb-4" />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" onClick={start} disabled={overQuota} leftIcon={<Download className="w-4 h-4" />}>
                {t('gallery.prepareDownload', 'Prepare download')}
              </Button>
            </div>
          </>
        )}

        {phase === 'preparing' && (
          <div className="py-6 text-center">
            <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin text-accent" />
            <p className="text-sm font-medium text-theme">
              {t('gallery.preparingDownload', 'Preparing your download…')}
            </p>
            <p className="text-xs text-muted-theme mt-1">
              {photoCount > 0
                ? t('gallery.preparingProgress', '{{count}} photos packaged', { count: photoCount })
                : t('gallery.preparingHint', 'Resizing photos — this can take a moment for large galleries.')}
            </p>
          </div>
        )}

        {phase === 'ready' && (
          <div className="py-6 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full status-chip hue-success flex items-center justify-center">
              <Check className="w-6 h-6" />
            </div>
            <p className="text-sm font-medium text-theme mb-4">
              {t('gallery.downloadReady', 'Your download is ready')}
            </p>
            {parts.length > 1 ? (
              <>
                <p className="text-sm text-muted-theme mb-4">
                  {t('gallery.downloadPartsIntro', 'This download comes in {{total}} parts. You need all of them to get every photo.', {
                    total: parts.length,
                  })}
                </p>
                <ul className="space-y-2 text-left max-h-[50vh] overflow-y-auto">
                  {parts.map((item) => (
                    <li
                      key={item.part}
                      className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg border border-border-token"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-theme">
                          {t('gallery.downloadPartLabel', 'Part {{part}} of {{total}}', {
                            part: item.part,
                            total: parts.length,
                          })}
                        </span>
                        <span className="block text-xs text-muted-theme">
                          {formatFileSize(item.size_bytes)}
                          {startedParts.includes(item.part) && ` · ${t('gallery.downloadPartStarted', 'Download started')}`}
                        </span>
                      </span>
                      <Button
                        variant={startedParts.includes(item.part) ? 'outline' : 'primary'}
                        size="sm"
                        onClick={() => download(item.part)}
                        leftIcon={<Download className="w-4 h-4" />}
                        aria-label={t('gallery.downloadPartAction', 'Download part {{part}}', { part: item.part })}
                      >
                        {t('gallery.downloadNow', 'Download')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Button variant="primary" onClick={() => download()} leftIcon={<Download className="w-4 h-4" />}>
                {t('gallery.downloadNow', 'Download')}
              </Button>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="py-6 text-center">
            <AlertCircle className="w-8 h-8 mx-auto mb-3 text-status hue-danger" />
            <p className="text-sm text-theme mb-4">{error}</p>
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
      </div>
    </div>
  );
};
