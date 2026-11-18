import { useSyncExternalStore } from 'react';
import { isUploadInterrupted, subscribeUploadInterruptions } from '../services/guestChunkedUpload';

/**
 * True while a chunked upload waits to resume after a failed chunk (the
 * connection dropped, or the page was in the background), for a short
 * "connection interrupted – resuming…" note next to the progress.
 */
export function useUploadInterrupted(): boolean {
  return useSyncExternalStore(subscribeUploadInterruptions, isUploadInterrupted, isUploadInterrupted);
}
