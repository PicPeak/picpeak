import { useEffect, useRef, useState } from 'react';
import {
  uploadsService,
  type UploadStatusSnapshot,
} from '../services/uploads.service';

interface UseUploadProgressOptions {
  /**
   * If false, the hook does nothing (used to "pause" tracking when no
   * upload is in progress). Default: true.
   */
  enabled?: boolean;
  /**
   * Polling interval in ms (used always as a fallback, and as the
   * primary channel when SSE is unavailable). Default: 1500.
   */
  pollIntervalMs?: number;
  /**
   * If true, attempts an SSE upgrade for low-latency updates and
   * falls back to polling when the stream errors. Default: true.
   */
  preferStream?: boolean;
}

/**
 * Tracks an upload group's processing state. Returns a merged snapshot
 * across all upload IDs the caller passes in (admin upload modal sends
 * each chunk as its own upload_id; this hook merges their counters).
 *
 * The hook is resilient: it always polls in the background and uses
 * SSE (when available and not disabled) as a faster supplementary
 * channel. Either source landing on a terminal state stops the hook.
 */
export function useUploadProgress(
  uploadIds: string[],
  { enabled = true, pollIntervalMs = 1500, preferStream = true }: UseUploadProgressOptions = {}
) {
  const [snapshots, setSnapshots] = useState<Record<string, UploadStatusSnapshot | null>>({});
  const [error, setError] = useState<Error | null>(null);
  const eventSourcesRef = useRef<Record<string, EventSource>>({});
  // Stable string key so we re-trigger the effect only when the actual
  // set of IDs changes (parents may pass a new array each render).
  const idsKey = uploadIds.join('|');

  useEffect(() => {
    if (!enabled || uploadIds.length === 0) {
      return undefined;
    }

    let cancelled = false;
    const pollHandles: Record<string, ReturnType<typeof setTimeout>> = {};

    const closeStream = (uploadId: string) => {
      const es = eventSourcesRef.current[uploadId];
      if (es) {
        es.close();
        delete eventSourcesRef.current[uploadId];
      }
    };

    const isTerminal = (snap: UploadStatusSnapshot | null) =>
      !!snap && snap.pending === 0 && snap.processing === 0;

    const merge = (uploadId: string, snap: UploadStatusSnapshot) => {
      if (cancelled) return;
      setSnapshots((prev) => ({ ...prev, [uploadId]: snap }));
    };

    const pollOnce = async (uploadId: string) => {
      try {
        const snap = await uploadsService.getStatus(uploadId);
        merge(uploadId, snap);
        if (!isTerminal(snap)) {
          pollHandles[uploadId] = setTimeout(() => pollOnce(uploadId), pollIntervalMs);
        } else {
          closeStream(uploadId);
        }
      } catch (e) {
        if (!cancelled) setError(e as Error);
        // Retry polling on error after a longer interval — don't drop
        // the group entirely just because one snapshot failed.
        pollHandles[uploadId] = setTimeout(() => pollOnce(uploadId), pollIntervalMs * 4);
      }
    };

    const tryStream = (uploadId: string) => {
      if (typeof EventSource === 'undefined') return;
      try {
        const es = new EventSource(uploadsService.streamUrl(uploadId), { withCredentials: true });
        eventSourcesRef.current[uploadId] = es;

        es.onmessage = (event) => {
          try {
            const payload: UploadStatusSnapshot = JSON.parse(event.data);
            merge(uploadId, payload);
            if (isTerminal(payload)) {
              closeStream(uploadId);
            }
          } catch (_) {
            /* ignore malformed event */
          }
        };

        es.onerror = () => {
          // Treat any error as a fatal stream failure; polling keeps
          // running anyway and will pick up status. Avoids reconnect
          // storms on broken proxies.
          closeStream(uploadId);
        };
      } catch (_) {
        // EventSource construction failed — polling alone covers it.
      }
    };

    for (const uploadId of uploadIds) {
      pollOnce(uploadId);
      if (preferStream) tryStream(uploadId);
    }

    return () => {
      cancelled = true;
      for (const handle of Object.values(pollHandles)) clearTimeout(handle);
      for (const uploadId of Object.keys(eventSourcesRef.current)) closeStream(uploadId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, enabled, pollIntervalMs, preferStream]);

  // Aggregate counters across all tracked upload IDs.
  const aggregate = (() => {
    const totals = { total: 0, pending: 0, processing: 0, complete: 0, failed: 0 };
    const failedPhotos: { id: number; filename: string; error: string | null }[] = [];
    let allReady = true;
    for (const uploadId of uploadIds) {
      const snap = snapshots[uploadId];
      if (!snap) {
        allReady = false;
        continue;
      }
      totals.total += snap.total;
      totals.pending += snap.pending;
      totals.processing += snap.processing;
      totals.complete += snap.complete;
      totals.failed += snap.failed;
      for (const p of snap.photos) {
        if (p.status === 'failed') {
          failedPhotos.push({ id: p.id, filename: p.original_filename, error: p.error });
        }
      }
    }
    const isComplete = allReady && totals.pending === 0 && totals.processing === 0 && totals.total > 0;
    return { ...totals, failedPhotos, isComplete, isReady: allReady };
  })();

  return {
    snapshots,
    aggregate,
    error,
  };
}
