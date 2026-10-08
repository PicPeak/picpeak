/**
 * Authenticated uploads are refused with one of these codes while the server
 * is busy (staging room or a concurrency slot is taken, or a body timed out).
 * Nothing is wrong with the files: the same request goes through a little
 * later, so the admin uploader waits and retries instead of failing them.
 */
const TRANSIENT_CODES = new Set([
  'UPLOAD_PENDING_LIMIT', 'UPLOAD_CONCURRENCY_LIMIT', 'UPLOAD_TIMEOUT', 'UPLOAD_REQUEST_TIMEOUT',
]);

export const isTransientUploadRefusal = (code: unknown): boolean =>
  typeof code === 'string' && TRANSIENT_CODES.has(code);

/** Ten retries over about four minutes. */
export const CAPACITY_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000, 30000, 30000, 40000, 40000, 40000];

interface RetryOptions {
  delaysMs?: number[];
  signal?: AbortSignal;
  /** Called before each wait with the retry about to be made (1-based) and the total, then with null. */
  onWaiting?: (waiting: { attempt: number; total: number } | null) => void;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * Run `send`; while it fails with a transient capacity code, wait and send
 * again. Any other failure, an abort, or the last retry's failure is thrown.
 */
export async function retryWhileBusy<T>(send: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { delaysMs = CAPACITY_RETRY_DELAYS_MS, signal, onWaiting } = options;
  for (let retry = 0; ; retry++) {
    try {
      return await send();
    } catch (error: any) {
      if (retry >= delaysMs.length || signal?.aborted || !isTransientUploadRefusal(error?.response?.data?.code)) throw error;
      onWaiting?.({ attempt: retry + 1, total: delaysMs.length });
      await sleep(delaysMs[retry], signal);
      onWaiting?.(null);
      if (signal?.aborted) throw error;
    }
  }
}
