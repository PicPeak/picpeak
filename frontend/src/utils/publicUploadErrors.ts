/** Only server-defined upload capacity codes use these localized messages. */
export function publicUploadErrorKey(code: unknown): string | null {
  switch (code) {
    case 'UPLOAD_REQUEST_TOO_LARGE': return 'upload.capacity.batch';
    case 'UPLOAD_LIFETIME_LIMIT': return 'upload.capacity.lifetime';
    case 'UPLOAD_PENDING_LIMIT':
    case 'UPLOAD_CONCURRENCY_LIMIT': return 'upload.capacity.busy';
    case 'UPLOAD_BYTE_RATE_LIMIT': return 'upload.capacity.rate';
    case 'UPLOAD_STORAGE_LOW':
    case 'UPLOAD_QUOTA_UNAVAILABLE':
    case 'UPLOAD_RESERVATION_LOST': return 'upload.capacity.unavailable';
    case 'UPLOAD_CLEANUP_UNAVAILABLE': return 'upload.capacity.unavailable';
    case 'UPLOAD_REQUEST_TIMEOUT':
    case 'UPLOAD_TIMEOUT': return 'upload.capacity.timeout';
    case 'UPLOAD_TARGET_GONE': return 'upload.capacity.gone';
    default: return null;
  }
}
