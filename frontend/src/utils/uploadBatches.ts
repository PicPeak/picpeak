import { uploadMultipartBudget } from './uploadMultipartBudget';

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

/**
 * How a set of files goes up without any one request exceeding a proxy's body
 * limit (Cloudflare Free/Pro: 100 MB), as gallery uploads decide it: files
 * that fit go multipart, in batches under the budget; a file larger than the
 * budget goes on its own, in 10 MB chunks.
 */
export function planTransferFiles<T extends { size: number }>(
  files: T[],
  maxFiles: number,
  /** The server's raw per-request budget, if it named one; capped Cloudflare-safe. */
  requestBytes?: number,
): { batches: T[][]; chunked: T[] } {
  const budget = uploadMultipartBudget(requestBytes);
  return {
    batches: batchFilesForUpload(files.filter((f) => f.size <= budget), budget, maxFiles),
    chunked: files.filter((f) => f.size > budget),
  };
}
