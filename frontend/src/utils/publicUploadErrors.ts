/** Only server-defined upload capacity codes use these localized messages. */
export function publicUploadErrorKey(code: unknown): string | null {
  switch (code) {
    case 'MEDIA_RESOURCE_LIMIT':
    case 'MEDIA_OUTPUT_LIMIT':
    case 'IMAGE_RESOURCE_LIMIT': return 'upload.capacity.decoded';
    case 'MEDIA_INVALID_SIGNATURE': return 'upload.capacity.signature';
    case 'MEDIA_LEASE_BUSY':
    case 'MEDIA_QUEUE_FULL':
    case 'IMAGE_QUEUE_FULL': return 'upload.capacity.busy';
    case 'MEDIA_TIMEOUT':
    case 'MEDIA_CANCELLED':
    case 'IMAGE_TIMEOUT':
    case 'IMAGE_CANCELLED': return 'upload.capacity.timeout';
    case 'IMAGE_WORKER_UNAVAILABLE':
    case 'MEDIA_WORKER_UNAVAILABLE':
    case 'MEDIA_ADMISSION_UNAVAILABLE':
    case 'MEDIA_WORKER_FAILED':
    case 'MEDIA_LEASE_UNAVAILABLE':
    case 'MEDIA_SUPERSEDED':
    case 'MEDIA_ATTEMPT_REQUIRED':
    case 'IMAGE_ADMISSION_UNAVAILABLE':
    case 'IMAGE_WORKER_FAILED': return 'upload.capacity.processing';
    case 'UPLOAD_REQUEST_TOO_LARGE': return 'upload.capacity.batch';
    case 'UPLOAD_LIFETIME_LIMIT': return 'upload.capacity.lifetime';
    case 'UPLOAD_PENDING_LIMIT':
    case 'UPLOAD_CONCURRENCY_LIMIT': return 'upload.capacity.busy';
    case 'UPLOAD_BYTE_RATE_LIMIT':
    case 'UPLOAD_REQUEST_RATE_LIMIT': return 'upload.capacity.rate';
    case 'UPLOAD_STORAGE_LOW':
    case 'UPLOAD_QUOTA_UNAVAILABLE':
    case 'UPLOAD_RESERVATION_LOST': return 'upload.capacity.unavailable';
    case 'UPLOAD_CLEANUP_UNAVAILABLE': return 'upload.capacity.unavailable';
    case 'UPLOAD_REQUEST_TIMEOUT':
    case 'UPLOAD_TIMEOUT': return 'upload.capacity.timeout';
    default: return null;
  }
}
