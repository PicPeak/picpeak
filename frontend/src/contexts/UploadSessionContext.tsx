import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { api } from '../config/api';
import { photosService } from '../services/photos.service';
import { useUploadProgress } from '../hooks/useUploadProgress';

// The admin upload runs here, outside the upload modal, so the modal can close
// the moment the upload starts and the user keeps the rest of the admin while
// bytes and processing run. UploadProgressBar (mounted once in AdminLayout)
// renders whatever session is live; PhotoUpload only picks files and calls
// startUpload.

// Upload phase machine. The user perceives "frozen" during 'processing'
// because the bytes are already on the server and we're waiting for
// thumbnail/EXIF/etc. work — the explicit phase kills that perception
// (#352 / contributor analysis on issue 357 review).
export type UploadPhase =
  | { kind: 'transferring'; chunkIndex: number; totalChunks: number; bytePct: number }
  | { kind: 'processing'; chunkIndex: number; totalChunks: number; filesInChunk: number }
  | { kind: 'done' };

// Why a file didn't make it into the gallery. Each maps to a distinct
// stage so the user knows whether to re-pick the file (rejected), retry
// the network (transfer), or check the source image (processing).
//   - rejected:   validation/queueing refused it (bad type, too large,
//                 corrupt) — returned per-file in the upload response.
//   - transfer:   the whole chunk request failed (timeout, 5xx, network).
//   - processing: stored fine, but the background worker couldn't process
//                 it (from useUploadProgress's failedPhotos).
export type UploadFailureKind = 'rejected' | 'transfer' | 'processing';
export interface UploadFailure {
  filename: string;
  reason: string;
  kind: UploadFailureKind;
}

export interface UploadSession {
  eventId: number;
  /** Files handed to startUpload, before any server-side rejection. */
  fileCount: number;
  phase: UploadPhase;
  /** Overall transfer progress, 0–100, across every chunk and large file. */
  progress: number;
  currentChunk: number;
  totalChunks: number;
  /** Background processing counters, once photos are queued. */
  processing: { complete: number; failed: number; total: number };
  /** Files that landed in the gallery, known once the session is done. */
  uploadedCount: number;
  failures: UploadFailure[];
  /**
   * Done, but the worker's status could not be read: the photos are queued
   * and appear as it finishes; the counts above stop at what was known.
   */
  processingUnknown?: boolean;
}

export interface StartUploadOptions {
  eventId: number;
  files: File[];
  categoryId: number | null;
  replaceByName: boolean;
  /** Per-request caps, resolved by the picker from admin settings. */
  maxFilesPerChunk: number;
  maxBytesPerChunk: number;
}

interface UploadSessionContextValue {
  session: UploadSession | null;
  /** True while bytes are moving or the worker is still processing. */
  isUploading: boolean;
  startUpload: (options: StartUploadOptions) => void;
  /** Clears a finished session from the bar. No-op while uploading. */
  dismiss: () => void;
}

const UploadSessionContext = createContext<UploadSessionContextValue | undefined>(undefined);

export const UploadSessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<UploadSession | null>(null);
  // Upload IDs returned from each chunk POST. The processing tracker
  // hook merges status across all of them so the user sees one unified
  // progress count even when the upload spans multiple HTTP requests.
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  // Transfer-stage failures are kept in a ref as well as in the session so
  // the completion effect can merge processing failures without racing a
  // stale closure.
  const transferFailuresRef = useRef<UploadFailure[]>([]);
  // Files that were done by the time the transfer loop ended: large files
  // (their own chunked path) and replacements (the backend swaps the bytes
  // in the request). Neither goes through the worker, so the processing
  // aggregate never sees them; the outcome adds them back.
  const syncSucceededRef = useRef(0);
  // The transfer loop has returned: every POST has its response. Until then
  // the aggregate only covers the upload ids received so far, and a fast
  // worker can finish those while a later batch is still in flight — the
  // completion effect must not take that for the whole session.
  const [transferSettled, setTransferSettled] = useState(false);
  // Cancels the transfer loop when the provider goes away (logout, the 401
  // redirect): later batches must not keep POSTing into a session nobody
  // sees, and a fresh mount starts from nothing.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const isUploading = session !== null && session.phase.kind !== 'done';

  const { aggregate: processingAggregate } = useUploadProgress(uploadIds, {
    enabled: session?.phase.kind === 'processing' && uploadIds.length > 0,
  });

  const patch = useCallback((update: Partial<UploadSession> | ((prev: UploadSession) => Partial<UploadSession>)) => {
    setSession((prev) => {
      if (!prev) return prev;
      const next = typeof update === 'function' ? update(prev) : update;
      return { ...prev, ...next };
    });
  }, []);

  // Refresh the event's photo grid and counters. Fired as bytes land and
  // again when processing finishes — a refresh signal only, the outcome
  // toast is decided below where the counts are known.
  const refreshEvent = useCallback((eventId: number) => {
    const id = String(eventId);
    queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
    queryClient.invalidateQueries({ queryKey: ['admin-event-photos', id] });
    queryClient.invalidateQueries({ queryKey: ['admin-photo-credits', eventId] });
  }, [queryClient]);

  const startUpload = useCallback(({ eventId, files, categoryId, replaceByName, maxFilesPerChunk, maxBytesPerChunk }: StartUploadOptions) => {
    if (files.length === 0) return;

    // Split: large singles use resumable/chunked API; the rest keep the proven multipart path.
    // #509: the per-chunk byte cap is tunable so users behind Cloudflare Tunnel and other
    // reverse proxies with request-size limits can drop it below their proxy's cap. That cap
    // only splits *sets* of files: a lone file above it goes through the chunked-upload API
    // (10MB parts, reachable since #1377).
    const largeFiles = files.filter((f) => photosService.shouldUseChunkedUpload(f.size, maxBytesPerChunk));
    const smallFiles = files.filter((f) => !photosService.shouldUseChunkedUpload(f.size, maxBytesPerChunk));

    // The chunked complete step has no replace flag, so a large file with
    // replace-by-name on would silently land as a second copy. Skip it and
    // say so in the report rather than behind a toast.
    const skippedForReplace: UploadFailure[] = replaceByName
      ? largeFiles.map((f) => ({
          filename: f.name,
          reason: t(
            'upload.largeFileReplaceSkipped',
            'Replace-by-name is not supported for files above the batch size; upload it without replace.'
          ),
          kind: 'rejected' as const,
        }))
      : [];
    const largeFilesToUpload = replaceByName ? [] : largeFiles;

    const chunks: File[][] = [];
    let currentChunk: File[] = [];
    let currentChunkSize = 0;
    for (const file of smallFiles) {
      if (currentChunk.length >= maxFilesPerChunk ||
          (currentChunkSize + file.size > maxBytesPerChunk && currentChunk.length > 0)) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChunkSize = 0;
      }
      currentChunk.push(file);
      currentChunkSize += file.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    // Treat each large file as its own "unit" for progress (after multipart batches).
    const totalUnits = chunks.length + largeFilesToUpload.length;

    transferFailuresRef.current = [];
    syncSucceededRef.current = 0;
    setTransferSettled(false);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setUploadIds([]);
    setSession({
      eventId,
      fileCount: files.length,
      phase: { kind: 'transferring', chunkIndex: 0, totalChunks: totalUnits, bytePct: 0 },
      progress: 0,
      currentChunk: 0,
      totalChunks: Math.max(totalUnits, 1),
      processing: { complete: 0, failed: 0, total: 0 },
      uploadedCount: 0,
      failures: [],
      processingUnknown: false,
    });

    const run = async () => {
      let totalReplaced = 0;
      // Accumulates transfer-stage failures (per-file rejections + whole-chunk
      // failures) with their reasons, so the report can name each one.
      const collected: UploadFailure[] = [...skippedForReplace];
      // Whether at least one chunk was accepted for background processing.
      let anyQueued = false;
      // Large-file chunked path processes synchronously on complete — count
      // successes so we can settle immediately when nothing is left in the
      // async worker.
      let largeSucceeded = 0;
      let unitIndex = 0;

      try {
        // --- Large files: existing backend chunked-upload (10MB parts) ---
        for (const file of largeFilesToUpload) {
          if (controller.signal.aborted) return;
          const index = unitIndex;
          patch({ currentChunk: index + 1, phase: { kind: 'transferring', chunkIndex: index, totalChunks: totalUnits, bytePct: 0 } });
          try {
            await photosService.uploadLargeFile(eventId, file, categoryId, (pct) => {
              // pct is 0–100 for this file's chunks only
              const overall = totalUnits > 0 ? ((index + Math.min(pct, 100) / 100) / totalUnits) * 100 : pct;
              patch({
                progress: Math.round(overall),
                phase: { kind: 'transferring', chunkIndex: index, totalChunks: totalUnits, bytePct: Math.round(Math.min(pct, 100)) },
              });
            });
            largeSucceeded += 1;
            // complete() already ran ffmpeg + insert — refresh grid
            refreshEvent(eventId);
          } catch (error: any) {
            console.error(`Error uploading large file ${file.name}:`, error);
            const reason = error?.response?.data?.error || error?.message || t('upload.failures.transferReason', 'Transfer failed');
            collected.push({ filename: file.name, reason, kind: 'transfer' });
          }
          unitIndex += 1;
        }

        // --- Small files: existing multipart batch path ---
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          if (controller.signal.aborted) return;
          const index = unitIndex;
          const chunk = chunks[chunkIndex];
          const formData = new FormData();
          chunk.forEach((file) => formData.append('photos', file));
          if (categoryId) formData.append('category_id', categoryId.toString());
          if (replaceByName) formData.append('replace_by_name', 'true');

          patch({ currentChunk: index + 1, phase: { kind: 'transferring', chunkIndex: index, totalChunks: totalUnits, bytePct: 0 } });

          try {
            const response = await api.post(`/admin/events/${eventId}/upload`, formData, {
              signal: controller.signal,
              onUploadProgress: (progressEvent) => {
                if (!progressEvent.total) return;
                const chunkProgress = progressEvent.loaded / progressEvent.total;
                const overallProgress = totalUnits > 0 ? ((index + chunkProgress) / totalUnits) * 100 : chunkProgress * 100;
                // Once bytes have all left the browser, the request is
                // sitting in the backend processing pipeline. Flip to
                // 'processing' so the UI explains the wait instead of
                // looking frozen at the chunk's max progress.
                patch((prev) => ({
                  progress: Math.round(overallProgress),
                  phase:
                    chunkProgress >= 1
                      ? prev.phase.kind === 'transferring' && prev.phase.chunkIndex === index
                        ? { kind: 'processing', chunkIndex: index, totalChunks: totalUnits, filesInChunk: chunk.length }
                        : prev.phase
                      : { kind: 'transferring', chunkIndex: index, totalChunks: totalUnits, bytePct: Math.round(chunkProgress * 100) },
                }));
              },
            });

            totalReplaced += (response.data?.replacedCount || 0);
            // The backend accepts the request (202) but may reject individual
            // files (bad type, too large, corrupt) and reports them in
            // `errors: [{ filename, error }]`. Surface each one by name.
            const rejected = response.data?.errors;
            if (Array.isArray(rejected)) {
              for (const r of rejected) {
                collected.push({
                  filename: r?.filename || t('upload.failures.unknownFile', 'Unknown file'),
                  reason: r?.error || t('upload.failures.unknownReason', 'Unknown error'),
                  kind: 'rejected',
                });
              }
            }
            // Track the per-request upload_id so the processing hook can poll
            // for live progress — but only when photos were actually queued
            // (count > 0). The backend returns an upload_id even when every
            // file was rejected (count 0); tracking it there would make us wait
            // for a processing phase that never starts, hanging the bar.
            if (response.data?.upload_id && (response.data?.count ?? 0) > 0) {
              anyQueued = true;
              const newId = response.data.upload_id as string;
              setUploadIds((prev) => (prev.includes(newId) ? prev : [...prev, newId]));
            }
          } catch (error: any) {
            if (controller.signal.aborted) return;
            console.error(`Error uploading chunk ${chunkIndex + 1}:`, error);
            const reason = error?.response?.data?.error || error?.message || t('upload.failures.transferReason', 'Transfer failed');
            collected.push(...chunk.map((f) => ({ filename: f.name, reason, kind: 'transfer' as const })));
            // Continue with next chunk even if one fails
          }
          unitIndex += 1;
        }

        if (totalReplaced > 0) {
          toast.info(t('upload.replacedFiles', { count: totalReplaced }) || `${totalReplaced} photo(s) replaced`);
        }
        // Publish transfer-stage failures to the report. The toast is just the
        // headline; the list in the bar is where the user finds out *which*
        // files failed.
        transferFailuresRef.current = collected;
        syncSucceededRef.current = largeSucceeded + totalReplaced;
        setTransferSettled(true);
        patch({ failures: collected });
        if (collected.length > 0) {
          toast.warning(
            t('upload.failures.toast', '{{count}} file(s) could not be uploaded — details in the upload bar at the top.', { count: collected.length })
          );
        } else if (largeSucceeded + totalReplaced > 0 && !anyQueued) {
          toast.success(t('upload.uploadComplete') || `Successfully uploaded ${largeSucceeded + totalReplaced} file(s)`);
        }

        // Refresh the grid early so the user sees their photos appearing
        // as the worker processes them. The completion effect below
        // refreshes again once processing finishes.
        refreshEvent(eventId);

        // If nothing was queued (every file rejected, or a pre-async backend),
        // the transfer stage is already terminal — the session is done now.
        // Otherwise the processing effect below finishes it once the worker
        // is through, so processing failures land in the same report.
        if (!anyQueued) {
          patch({ phase: { kind: 'done' }, progress: 100, uploadedCount: largeSucceeded + totalReplaced });
        } else {
          // Bytes are all on the server. Make sure the tracker is armed even
          // when the browser never reported a final progress event.
          patch((prev) =>
            prev.phase.kind === 'processing'
              ? {}
              : { progress: 100, phase: { kind: 'processing', chunkIndex: Math.max(totalUnits - 1, 0), totalChunks: totalUnits, filesInChunk: 0 } }
          );
        }
      } catch (error: any) {
        if (controller.signal.aborted) return;
        console.error('Upload error:', error);
        toast.error(error.response?.data?.error || t('toast.uploadError'));
        setUploadIds([]);
        setSession(null);
      }
    };

    void run();
  }, [patch, refreshEvent, t]);

  // When the background worker finishes processing every photo from
  // this upload, close the session and surface the result.
  useEffect(() => {
    if (!session || session.phase.kind === 'done') return;
    if (!transferSettled) return;
    if (uploadIds.length === 0) return;
    if (!processingAggregate.isComplete) return;

    const transferFailures = transferFailuresRef.current;
    const uploaded = processingAggregate.complete + syncSucceededRef.current;
    const processingFailures: UploadFailure[] = processingAggregate.failedPhotos.map((p) => ({
      filename: p.filename,
      reason: p.error || t('upload.failures.unknownReason', 'Unknown error'),
      kind: 'processing' as const,
    }));

    if (processingAggregate.failed > 0) {
      toast.warning(
        t('upload.processingFailed', { count: processingAggregate.failed }) ||
          `${processingAggregate.failed} photo(s) failed to process`
      );
    } else if (transferFailures.length > 0) {
      // Processing was clean, but files were rejected or lost before they got
      // there. A plain "Upload complete!" here would contradict the failure
      // report (QA P4-B.05 / 7.05) — report the real split.
      toast.warning(
        t('upload.partialComplete', '{{uploaded}} of {{total}} files uploaded — {{failed}} could not be uploaded.', {
          uploaded,
          total: uploaded + transferFailures.length,
          failed: transferFailures.length,
        })
      );
    } else {
      toast.success(t('upload.uploadComplete') || `Successfully uploaded ${uploaded} photo(s)`);
    }

    refreshEvent(session.eventId);
    patch({
      phase: { kind: 'done' },
      progress: 100,
      processing: { complete: processingAggregate.complete, failed: processingAggregate.failed, total: processingAggregate.total },
      uploadedCount: uploaded,
      failures: [...transferFailures, ...processingFailures],
    });
    setUploadIds([]);
    // We intentionally only react to processingAggregate.isComplete /
    // .failed — the rest of the deps either don't move during this
    // effect's lifetime or are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processingAggregate.isComplete, processingAggregate.failed, session?.phase.kind, uploadIds.length, transferSettled]);

  // The worker's status could not be read maxConsecutiveFailures times in
  // a row (a broken status route, a proxy that 404s it): end the session
  // with what is known rather than sit in "processing" for good. The
  // photos are queued server-side either way and appear as it finishes.
  useEffect(() => {
    if (!session || session.phase.kind === 'done') return;
    if (!transferSettled || uploadIds.length === 0) return;
    if (!processingAggregate.isStalled) return;

    const transferFailures = transferFailuresRef.current;
    toast.warning(t('upload.bar.statusUnavailable', 'Processing status could not be read — the photos are queued and appear as the worker finishes.'));
    refreshEvent(session.eventId);
    patch({
      phase: { kind: 'done' },
      progress: 100,
      processing: { complete: processingAggregate.complete, failed: processingAggregate.failed, total: processingAggregate.total },
      uploadedCount: processingAggregate.complete + syncSucceededRef.current,
      failures: transferFailures,
      processingUnknown: true,
    });
    setUploadIds([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processingAggregate.isStalled, session?.phase.kind, uploadIds.length, transferSettled]);

  // Live processing counters for the bar while the worker runs.
  useEffect(() => {
    if (!session || session.phase.kind !== 'processing') return;
    if (processingAggregate.total === 0) return;
    patch({
      processing: {
        complete: processingAggregate.complete,
        failed: processingAggregate.failed,
        total: processingAggregate.total,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processingAggregate.complete, processingAggregate.failed, processingAggregate.total, session?.phase.kind]);

  // The modal no longer holds the user on the page, so closing the tab
  // mid-transfer is the one way to lose an upload without noticing. Only
  // while bytes are still leaving the browser: once every transfer has its
  // response the worker finishes on the server whether this tab stays or
  // not, and a prompt then would only get in the way — of a 401 redirect
  // among other things.
  const transferring = isUploading && !transferSettled;
  useEffect(() => {
    if (!transferring) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [transferring]);

  // A clean finish needs no acknowledgement: the toast said it, the grid
  // shows it. Failures stay until dismissed so the list can be acted on.
  useEffect(() => {
    if (!session || session.phase.kind !== 'done' || session.failures.length > 0 || session.processingUnknown) return;
    const handle = setTimeout(() => setSession(null), 4000);
    return () => clearTimeout(handle);
  }, [session]);

  const dismiss = useCallback(() => {
    setSession((prev) => (prev && prev.phase.kind === 'done' ? null : prev));
  }, []);

  const value = useMemo(
    () => ({ session, isUploading, startUpload, dismiss }),
    [session, isUploading, startUpload, dismiss]
  );

  return <UploadSessionContext.Provider value={value}>{children}</UploadSessionContext.Provider>;
};

export function useUploadSession(): UploadSessionContextValue {
  const ctx = useContext(UploadSessionContext);
  if (!ctx) {
    throw new Error('useUploadSession must be used within an UploadSessionProvider');
  }
  return ctx;
}
