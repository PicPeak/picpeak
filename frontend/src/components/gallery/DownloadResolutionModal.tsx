import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Check, AlertCircle, X, Loader2, Mail } from 'lucide-react';

import { Button } from '../common';
import { galleryService } from '../../services/gallery.service';
import type { DownloadResolutionChoice, DownloadJobState, DownloadJobStatus } from '../../types';
import { useDownloadQuota } from '../../contexts/DownloadQuotaContext';
import { useDownloadChoice } from '../../contexts/DownloadChoiceContext';
import { downloadChoiceKind, knownTotalBytes } from '../../utils/downloadChoice';
import { formatFileSize } from '../../utils/fileSize';
import {
  isDownloadLimitError, isGalleryLimited, isSelectionTooLargeError, notifyDownloadQuotaChanged,
  selectionTooLargeMessage, showDownloadLimitReached, type QuotaPhoto,
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
 *
 * While preparing, a visitor the server holds an address for can ask to be
 * mailed instead of waiting (issue 1733). The link in that mail opens the
 * gallery with `resumeToken`, which starts this dialog at that job.
 *
 * It is also the download menu for one photo (issue 1733, E2): with `onPick`
 * the choice is handed back to start that photo's download, no job involved.
 * Each size says in plain words what it is for, the file size where the
 * payload knows it, and what the gallery's protection does to it.
 */

/** What the size line can tell about a photo; GalleryPhoto fits. */
type SizedPhoto = QuotaPhoto & { size?: number | null; width?: number | null; height?: number | null };

const HINT_FALLBACK: Record<ReturnType<typeof downloadChoiceKind>, string> = {
  original: 'Full quality, as the photographer delivered it — best for printing.',
  print: 'High resolution — for prints and large screens.',
  screen: 'Web size — for screens, sharing and social media.',
  small: 'Smallest file — quick to send in messages.',
};

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
  quotaPhotos?: SizedPhoto[];
  /** One photo's download menu (issue 1733, E2): its own pixel and file size. */
  photo?: SizedPhoto;
  /** Download menu mode: the picked size goes back here instead of a job. */
  onPick?: (resolution: string) => void;
  /** A job to pick up again, from the "your download is ready" mail (issue 1733). */
  resumeToken?: string;
  onClose: () => void;
  /** Called, before onClose, once a download was handed to the browser. */
  onDownloaded?: () => void;
}

export const DownloadResolutionModal: React.FC<DownloadResolutionModalProps> = ({
  slug,
  choices,
  standardResolution,
  photoIds,
  quotaPhotos,
  photo,
  onPick,
  resumeToken,
  onClose,
  onDownloaded,
}) => {
  const { t } = useTranslation();
  const downloadQuota = useDownloadQuota();
  const { watermarked } = useDownloadChoice();
  const overQuota = !!quotaPhotos && !downloadQuota.allows(quotaPhotos);
  const [phase, setPhase] = useState<Phase>(resumeToken ? 'preparing' : 'choose');
  const [selected, setSelected] = useState<string>(choices[0]?.id ?? 'original');
  const [error, setError] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState(0);
  const [notify, setNotify] = useState<DownloadJobState['notify'] | 'failed'>(undefined);
  const tokenRef = useRef<string | null>(resumeToken ?? null);
  // Guards the polling loop against running on after unmount / close.
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const filename = `${slug}-${selected === 'original' ? 'original' : selected}.zip`;

  const poll = useCallback(async (token: string) => {
    for (let i = 0; i < MAX_POLLS; i += 1) {
      if (!activeRef.current) return;
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!activeRef.current) return;
      try {
        const state = await galleryService.getDownloadJob(slug, token);
        setPhotoCount(state.photo_count || 0);
        // A failed request stays shown; the poll must not offer it again.
        setNotify((current) => (current === 'failed' ? current : state.notify));
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
    if (onPick) {
      onPick(selected);
      onClose();
      return;
    }
    // Whole-gallery download at the gallery's OWN standard size is exactly
    // what the pre-built archive already contains — take it instead of
    // re-resizing and re-packaging the entire gallery for the same bytes.
    if (!photoIds && selected === standardResolution) {
      try {
        await galleryService.downloadAllPhotos(slug, true);
        onDownloaded?.();
      } catch (err) {
        // The limit refusal already told the guest why (issue 1560).
        if (!isDownloadLimitError(err)) throw err;
      }
      onClose();
      return;
    }

    setPhase('preparing');
    setError(null);
    // A new job: a mail request that failed for the last one says nothing about it.
    setNotify(undefined);
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
    } catch (err) {
      setError(isSelectionTooLargeError(err)
        ? selectionTooLargeMessage(err.info.limit)
        : isDownloadLimitError(err)
        ? t('gallery.downloadLimit.reached', 'Download limit reached. Please contact your photographer for more downloads.')
        : t('gallery.downloadPrepFailed', 'Preparation failed'));
      setPhase('error');
    }
  }, [slug, selected, photoIds, poll, t, standardResolution, onClose, onDownloaded, onPick]);

  // Pick a job up again from the mail link. It may have been swept since
  // (retention passed, or the gallery changed), which reads as not found;
  // not swept yet, it says `unavailable`.
  useEffect(() => {
    if (!resumeToken) return;
    (async () => {
      try {
        const state = await galleryService.getDownloadJob(slug, resumeToken);
        if (!activeRef.current) return;
        if (state.status === 'failed' || state.unavailable) throw new Error('gone');
        setSelected(state.resolution);
        if (state.status === 'ready') {
          setPhase('ready');
          return;
        }
        setNotify(state.notify);
        await poll(resumeToken);
      } catch {
        if (!activeRef.current) return;
        setError(t('gallery.downloadGone', 'This download is no longer available. Please request it again.'));
        setPhase('error');
      }
    })();
  }, [resumeToken, slug, poll, t]);

  const requestMail = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await galleryService.requestDownloadJobMail(slug, token);
      setNotify('requested');
    } catch {
      setNotify('failed');
    }
  }, [slug]);

  const download = useCallback(async () => {
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
    galleryService.downloadJobFile(slug, token, filename);
    onDownloaded?.();
    onClose();
  }, [slug, filename, onClose, onDownloaded, t]);

  // The original's file size, only where the payload knows it exactly: one
  // photo, or a selection (all loaded, as they were picked). Not for the
  // whole gallery — the list may be paged — and not with a watermark, which
  // re-encodes the file.
  const originalBytes = watermarked ? null
    : photo ? knownTotalBytes([photo])
    : photoIds && quotaPhotos
      ? knownTotalBytes(quotaPhotos.filter((p) => p.category_allow_downloads !== false))
      : null;

  const sizeLine = (choice: DownloadResolutionChoice): string | null => {
    if (choice.width && choice.height) {
      return t('gallery.resolutionUpTo', 'up to {{width}} × {{height}} px', {
        width: choice.width,
        height: choice.height,
      });
    }
    const parts: string[] = [];
    if (photo?.width && photo?.height) {
      parts.push(t('gallery.downloadMenu.pixels', '{{width}} × {{height}} px', { width: photo.width, height: photo.height }));
    }
    if (originalBytes) {
      parts.push(photo
        ? formatFileSize(originalBytes)
        : t('gallery.downloadMenu.totalSize', '{{size}} in total', { size: formatFileSize(originalBytes) }));
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  // The original is not among the sizes: say so, rather than let "Large"
  // pass for it.
  const largest = choices[0];
  const noOriginal = !choices.some((c) => c.id === 'original') && largest?.width && largest?.height
    ? t('gallery.downloadMenu.noOriginal', 'The original files are not offered in this gallery. The largest size is up to {{width}} × {{height}} px.', {
      width: largest.width,
      height: largest.height,
    })
    : null;

  const title = resumeToken
    ? t('gallery.preparedDownload', 'Your prepared download')
    : t('gallery.chooseResolution', 'Choose a download size');

  const panelRef = useRef<HTMLDivElement>(null);
  useGalleryDialog({ open: true, onClose, panelRef });

  return (
    <div
      // Above the Premium lightbox, whose portal sits at z-index 9999: the
      // single-photo menu (issue 1733, E2) opens over it.
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000] p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Scrolls inside the viewport: the hints make the list tall on a
        // short phone screen, and the body behind it does not scroll.
        className="card-themed text-theme p-6 max-w-md w-full max-h-full overflow-y-auto overscroll-contain"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-theme">
            {title}
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
            <fieldset className="mb-5">
              <legend className="sr-only">{title}</legend>
              <div className="space-y-2">
                {choices.map((choice) => {
                  const kind = downloadChoiceKind(choice);
                  const size = sizeLine(choice);
                  return (
                    <label
                      key={choice.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
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
                        className="accent-accent mt-1"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-theme">
                          {kind === 'original' ? t('gallery.downloadMenu.original', 'Original') : choice.label}
                        </span>
                        <span className="block text-xs text-muted-theme">
                          {t(`gallery.downloadMenu.hint.${kind}`, HINT_FALLBACK[kind])}
                        </span>
                        {size && (
                          <span className="block text-xs text-muted-theme tabular-nums">
                            {size}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {/* What the gallery's protection makes of every size above. */}
            {(watermarked || noOriginal) && (
              <ul className="mb-4 space-y-1 text-xs text-muted-theme">
                {watermarked && (
                  <li>{t('gallery.downloadMenu.watermarked', 'Every size carries the photographer\'s watermark, the original too.')}</li>
                )}
                {noOriginal && (
                  <li>{noOriginal}</li>
                )}
              </ul>
            )}
            {quotaPhotos && downloadQuota.limited && (
              <DownloadQuotaNotice photos={quotaPhotos} className="mb-4" />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" onClick={start} disabled={overQuota} leftIcon={<Download className="w-4 h-4" />}>
                {onPick ? t('gallery.downloadNow', 'Download') : t('gallery.prepareDownload', 'Prepare download')}
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
            {notify === 'available' && (
              <Button variant="outline" size="sm" className="mt-4" onClick={requestMail} leftIcon={<Mail className="w-4 h-4" />}>
                {t('gallery.downloadNotify', 'Email me when it is ready')}
              </Button>
            )}
            {notify === 'requested' && (
              <p className="text-xs text-theme mt-4" role="status">
                {t('gallery.downloadNotifyRequested', 'We will email you when the download is ready. You can close this window.')}
              </p>
            )}
            {notify === 'failed' && (
              <p className="text-xs text-theme mt-4" role="alert">
                {t('gallery.downloadNotifyFailed', 'The email notification could not be set up. Please keep this window open.')}
              </p>
            )}
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
            <Button variant="primary" onClick={download} leftIcon={<Download className="w-4 h-4" />}>
              {t('gallery.downloadNow', 'Download')}
            </Button>
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
              {/* A resumed job has no selection behind it to prepare again. */}
              {!resumeToken && (
                <Button variant="primary" onClick={() => setPhase('choose')}>
                  {t('common.retry', 'Try again')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
