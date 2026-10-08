/** Only server-defined upload capacity codes use these localized messages. */
export function publicUploadErrorKey(code: unknown): string | null {
  switch (code) {
    case 'IMAGE_RESOURCE_LIMIT': return 'upload.capacity.decoded';
    case 'IMAGE_QUEUE_FULL': return 'upload.capacity.busy';
    case 'IMAGE_TIMEOUT':
    case 'IMAGE_CANCELLED': return 'upload.capacity.timeout';
    case 'IMAGE_WORKER_UNAVAILABLE':
    case 'IMAGE_ADMISSION_UNAVAILABLE':
    case 'IMAGE_WORKER_FAILED': return 'upload.capacity.processing';
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

/**
 * The same codes for a signed-in admin: the reader runs the server, so the
 * text says what to do rather than "contact the owner".
 */
export function adminUploadErrorKey(code: unknown): string | null {
  switch (code) {
    case 'UPLOAD_REQUEST_TOO_LARGE': return 'upload.adminCapacity.batch';
    case 'UPLOAD_PENDING_LIMIT':
    case 'UPLOAD_CONCURRENCY_LIMIT': return 'upload.adminCapacity.busy';
    case 'UPLOAD_STORAGE_LOW': return 'upload.adminCapacity.storage';
    case 'UPLOAD_QUOTA_UNAVAILABLE':
    case 'UPLOAD_RESERVATION_LOST':
    case 'UPLOAD_CLEANUP_UNAVAILABLE': return 'upload.adminCapacity.unavailable';
    case 'UPLOAD_REQUEST_TIMEOUT':
    case 'UPLOAD_TIMEOUT': return 'upload.adminCapacity.timeout';
    default: return publicUploadErrorKey(code);
  }
}
