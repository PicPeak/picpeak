/**
 * isStorageUnavailableError decides whether a storage failure says anything
 * about the object (issue 1785). Too wide and a real problem is retried
 * forever behind a 503; too narrow and a timeout is read as a broken
 * rendition again.
 */
const { isStorageUnavailableError, isStorageNotFoundError } = require('../../src/services/storage/storageErrors');

const sdkError = (name, httpStatusCode) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

describe('isStorageUnavailableError', () => {
  it.each([
    ['a connection or socket-pool timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['a reset connection', Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
    ['a refused connection', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
    ['a DNS failure', Object.assign(new Error('dns'), { code: 'EAI_AGAIN' })],
    ['a timed-out network mount', Object.assign(new Error('nfs'), { code: 'ETIMEDOUT' })],
    ['a stale NFS handle', Object.assign(new Error('nfs'), { code: 'ESTALE' })],
    ['a socket timeout reported as a code', Object.assign(new Error('socket'), { code: 'ESOCKETTIMEDOUT' })],
    ['a request timeout named only in code', Object.assign(new Error('timeout'), { code: 'RequestTimeout' })],
    ['S3 throttling', sdkError('SlowDown', 503)],
    ['an S3 internal error', sdkError('InternalError', 500)],
    ['a 429 without a known name', sdkError('Unknown', 429)],
    ['a 5xx without a known name', sdkError('Unknown', 502)],
  ])('is true for %s', (_label, err) => {
    expect(isStorageUnavailableError(err)).toBe(true);
  });

  it.each([
    ['a missing object', sdkError('NotFound', 404)],
    ['denied access', sdkError('AccessDenied', 403)],
    ['a bad request', sdkError('InvalidRequest', 400)],
    ['a missing local file', Object.assign(new Error('enoent'), { code: 'ENOENT' })],
    ['a local permission error', Object.assign(new Error('eacces'), { code: 'EACCES' })],
    ['an I/O error, which one damaged file reports too', Object.assign(new Error('eio'), { code: 'EIO' })],
    ['an image that does not parse', new Error('Input file contains unsupported image format')],
    ['nothing', null],
    ['a string', 'TimeoutError'],
  ])('is false for %s', (_label, err) => {
    expect(isStorageUnavailableError(err)).toBe(false);
  });
});

// Issue 2118: a read that misses a key stat() just found answers 404, the
// way the failed stat does. Only "not there" counts; everything else is 500.
describe('isStorageNotFoundError', () => {
  it.each([
    ['a missing local file', Object.assign(new Error('enoent'), { code: 'ENOENT' })],
    ['an S3 GetObject on a missing key', sdkError('NoSuchKey', 404)],
    ['an S3 HeadObject on a missing key', sdkError('NotFound', 404)],
    ['a bare 404', sdkError('UnknownError', 404)],
  ])('is true for %s', (_label, err) => {
    expect(isStorageNotFoundError(err)).toBe(true);
  });

  it.each([
    ['denied access', sdkError('AccessDenied', 403)],
    ['a timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['a server error', sdkError('InternalError', 500)],
    ['a local permission error', Object.assign(new Error('eacces'), { code: 'EACCES' })],
    ['nothing', null],
    ['a string', 'ENOENT'],
  ])('is false for %s', (_label, err) => {
    expect(isStorageNotFoundError(err)).toBe(false);
  });
});
