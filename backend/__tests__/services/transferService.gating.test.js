/**
 * Unit tests for the pure gating logic in transferService (PicTransfer, #997).
 * These exercise the download/upload eligibility rules without touching the DB.
 *
 * Since #1544 a transfer is a send OR a request (migration 257), so the gates
 * also enforce the split: only a send is downloadable, only a request is
 * uploadable. `make()` defaults to a send because that is what every
 * pre-existing row became.
 */
const transferService = require('../../src/services/transferService');

const HOUR = 60 * 60 * 1000;

function make(overrides = {}) {
  return {
    id: 1,
    title: 'T',
    kind: 'send',
    is_active: true,
    deleted_at: null,
    expires_at: new Date(Date.now() + 24 * HOUR),
    max_downloads: null,
    download_count: 0,
    allow_uploads: false,
    upload_expires_at: null,
    ...overrides,
  };
}

describe('transferService.downloadsRemaining', () => {
  it('returns null (unlimited) when no cap or zero cap', () => {
    expect(transferService.downloadsRemaining(make({ max_downloads: null }))).toBeNull();
    expect(transferService.downloadsRemaining(make({ max_downloads: 0 }))).toBeNull();
  });

  it('returns the remaining count and never goes negative', () => {
    expect(transferService.downloadsRemaining(make({ max_downloads: 5, download_count: 2 }))).toBe(3);
    expect(transferService.downloadsRemaining(make({ max_downloads: 5, download_count: 9 }))).toBe(0);
  });
});

describe('transferService.computeStatus', () => {
  it('is deleted when deleted_at set, regardless of activity', () => {
    expect(transferService.computeStatus(make({ deleted_at: new Date(), is_active: true }))).toBe('deleted');
  });
  it('is expired when inactive or past expiry', () => {
    expect(transferService.computeStatus(make({ is_active: false }))).toBe('expired');
    expect(transferService.computeStatus(make({ expires_at: new Date(Date.now() - HOUR) }))).toBe('expired');
  });
  it('is active within the window', () => {
    expect(transferService.computeStatus(make())).toBe('active');
  });
});

describe('transferService.assertDownloadable', () => {
  it('allows a live, in-window, uncapped transfer', () => {
    expect(transferService.assertDownloadable(make()).ok).toBe(true);
  });
  it('404s a missing/deleted transfer', () => {
    expect(transferService.assertDownloadable(null)).toMatchObject({ ok: false, status: 404 });
    expect(transferService.assertDownloadable(make({ deleted_at: new Date() }))).toMatchObject({ ok: false, status: 404 });
  });
  it('410s when disabled or expired', () => {
    expect(transferService.assertDownloadable(make({ is_active: false }))).toMatchObject({ ok: false, code: 'TRANSFER_DISABLED', status: 410 });
    expect(transferService.assertDownloadable(make({ expires_at: new Date(Date.now() - HOUR) }))).toMatchObject({ ok: false, code: 'TRANSFER_EXPIRED', status: 410 });
  });
  it('410s when the download cap is reached', () => {
    expect(transferService.assertDownloadable(make({ max_downloads: 2, download_count: 2 })))
      .toMatchObject({ ok: false, code: 'DOWNLOAD_LIMIT_REACHED', status: 410 });
  });
  it('404s a file request — its received files are not the link holder\'s', () => {
    expect(transferService.assertDownloadable(make({ kind: 'request', allow_uploads: true })))
      .toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 });
  });
});

describe('expiry checks fail closed', () => {
  // `new Date(x).getTime() <= Date.now()` is FALSE for an unparseable stamp, so
  // the old shape kept a corrupted row downloadable (and accepting uploads)
  // forever. Every guard now asks "is this a usable timestamp in the future?".
  const BAD = [null, undefined, '', 'not a date', NaN, {}];

  it.each(BAD)('assertDownloadable treats %p as expired, not eternal', (value) => {
    expect(transferService.assertDownloadable(make({ expires_at: value })))
      .toMatchObject({ ok: false, code: 'TRANSFER_EXPIRED', status: 410 });
  });

  it.each(BAD)('assertUploadable treats %p as expired, not eternal', (value) => {
    expect(transferService.assertUploadable(make({
      kind: 'request', allow_uploads: true, upload_expires_at: null, expires_at: value,
    }))).toMatchObject({ ok: false, code: 'UPLOAD_EXPIRED', status: 410 });
  });

  it.each(BAD)('computeStatus reports %p as expired', (value) => {
    expect(transferService.computeStatus(make({ expires_at: value }))).toBe('expired');
  });

  it('still accepts the timestamp shapes the two engines actually store', () => {
    const future = Date.now() + 24 * HOUR;
    // pg hands back a Date, SQLite a string or epoch millis.
    for (const value of [new Date(future), new Date(future).toISOString(), future]) {
      expect(transferService.stillInFuture(value)).toBe(true);
      expect(transferService.assertDownloadable(make({ expires_at: value })).ok).toBe(true);
    }
  });
});

describe('transferService.assertUploadable', () => {
  const request = (overrides = {}) => make({ kind: 'request', allow_uploads: true, ...overrides });

  it('404s a send — only a request takes uploads', () => {
    expect(transferService.assertUploadable(make({ allow_uploads: true })))
      .toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 });
  });
  it('403s when uploads are disabled', () => {
    expect(transferService.assertUploadable(request({ allow_uploads: false })))
      .toMatchObject({ ok: false, code: 'UPLOADS_DISABLED', status: 403 });
  });
  it('403s a request the admin has closed', () => {
    expect(transferService.assertUploadable(request({ is_active: false })))
      .toMatchObject({ ok: false, code: 'UPLOADS_DISABLED', status: 403 });
  });
  it('allows a live request', () => {
    expect(transferService.assertUploadable(request()).ok).toBe(true);
  });
  it('410s when the single deadline has passed', () => {
    expect(transferService.assertUploadable(request({ expires_at: new Date(Date.now() - HOUR) })))
      .toMatchObject({ ok: false, code: 'UPLOAD_EXPIRED', status: 410 });
  });
  it('410s on a legacy row whose upload_expires_at 257 has not yet converted', () => {
    expect(transferService.assertUploadable(request({ upload_expires_at: new Date(Date.now() - HOUR) })))
      .toMatchObject({ ok: false, code: 'UPLOAD_EXPIRED', status: 410 });
  });
});
