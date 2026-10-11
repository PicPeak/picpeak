/** Multipart part headers per file, and the closing boundary of the body. */
const PART_OVERHEAD_BYTES = 2048;
const BODY_OVERHEAD_BYTES = 4096;

/**
 * Split a selection into requests that each fit the server's per-request byte
 * budget and file count, keeping the order. A file larger than the budget
 * still gets a request of its own: the server is the one to refuse it.
 */
export function batchFilesForUpload<T extends { size: number }>(files: T[], maxRequestBytes: number, maxFiles: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = BODY_OVERHEAD_BYTES;
  for (const file of files) {
    const cost = file.size + PART_OVERHEAD_BYTES;
    if (current.length && (bytes + cost > maxRequestBytes || current.length >= maxFiles)) {
      batches.push(current);
      current = [];
      bytes = BODY_OVERHEAD_BYTES;
    }
    current.push(file);
    bytes += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** How long a paced retry may wait, and how often one request is retried. */
export const MAX_PACED_WAIT_SECONDS = 60;
export const MAX_PACED_RETRIES = 3;

/**
 * Seconds to wait before sending a refused upload request again, or null when
 * it must not be retried.
 *
 * A large selection goes up as many requests, and the upload route allows a
 * fixed number per minute. Its refusal is a plain 429 with Retry-After and no
 * error code; that one is worth waiting out. A 429 that carries a code is a
 * quota or lockout decision, and a wait longer than MAX_PACED_WAIT_SECONDS is
 * not something to sit through silently: both stop the upload as before.
 */
export function pacedRetryDelay(error: unknown): number | null {
  const response = (error as { response?: { status?: number; data?: { code?: string }; headers?: Record<string, unknown> } })?.response;
  if (response?.status !== 429 || response.data?.code) return null;
  const seconds = Number(response.headers?.['retry-after']);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_PACED_WAIT_SECONDS ? Math.ceil(seconds) : null;
}
