const DEFAULT_RAW_BYTES = 95 * 1024 * 1024;

// File sizes exclude multipart headers, boundaries and placement fields.
// Keep a conservative framing margin for the UI's at-most-50-file batches.
// The server remains authoritative, including operator-specific lower limits.
export function uploadMultipartBudget(configuredRawBytes = DEFAULT_RAW_BYTES): number {
  const raw = Number.isFinite(configuredRawBytes) && configuredRawBytes > 0
    ? Math.min(configuredRawBytes, DEFAULT_RAW_BYTES) : DEFAULT_RAW_BYTES;
  return Math.max(1, Math.floor(raw - Math.min(128 * 1024, raw / 4)));
}
