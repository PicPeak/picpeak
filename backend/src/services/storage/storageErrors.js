'use strict';

/**
 * Telling "the storage backend could not be reached" from "the object is not
 * there" (issue 1785).
 *
 * `storage.stat()` already keeps the two apart: it resolves null for a missing
 * object and throws for everything else. The rendition checks used to swallow
 * that throw and report the rendition as invalid, so an S3 timeout made a
 * healthy preview look broken and queued a download of the full original
 * through the client that was timing out. The routes then redirected the
 * guest to that same original.
 *
 * Only failures that say nothing about the object count here: no connection,
 * no free socket, a timeout, throttling, a 5xx. AccessDenied, a bad key or a
 * malformed request are answers about the request, and keep the old handling.
 */

// Node socket and DNS failures, as they surface through the AWS SDK's HTTP
// handler or a network-mounted local path. ESTALE is an NFS handle whose
// server went away. EIO is left out on purpose: it is also what one damaged
// file reports, and regenerating that rendition is the right repair.
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ESTALE',
]);

// What the SDK names a request that never got an answer, or one the service
// refused because it was busy. `TimeoutError` is also what a full socket pool
// raises: connectionTimeout includes the wait for a free socket.
const UNAVAILABLE_ERROR_NAMES = new Set([
  'TimeoutError', 'RequestTimeout', 'RequestTimeoutException',
  'SlowDown', 'ThrottlingException', 'Throttling', 'TooManyRequestsException',
  'ServiceUnavailable', 'InternalError',
]);

function isStorageUnavailableError(err) {
  if (!err || typeof err !== 'object') return false;
  if (NETWORK_ERROR_CODES.has(err.code)) return true;
  // Either field: the SDK names its errors, older handlers put the same
  // token in `code` (s3Storage's retry list reads both too).
  if (UNAVAILABLE_ERROR_NAMES.has(err.name) || UNAVAILABLE_ERROR_NAMES.has(err.code)) return true;
  const status = err.$metadata?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

module.exports = { isStorageUnavailableError };
