/**
 * Unit tests for the pure gating logic in transferService (PicTransfer, #997).
 * These exercise the download/upload eligibility rules without touching the DB.
 */
const transferService = require('../../src/services/transferService');

const HOUR = 60 * 60 * 1000;

function make(overrides = {}) {
  return {
    id: 1,
    title: 'T',
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
});

describe('transferService.assertUploadable', () => {
  it('403s when uploads are disabled', () => {
    expect(transferService.assertUploadable(make({ allow_uploads: false }))).toMatchObject({ ok: false, code: 'UPLOADS_DISABLED', status: 403 });
  });
  it('allows when uploads enabled and not expired', () => {
    expect(transferService.assertUploadable(make({ allow_uploads: true })).ok).toBe(true);
  });
  it('403s a transfer the admin deactivated while an upload was in flight', () => {
    expect(transferService.assertUploadable(make({ allow_uploads: true, is_active: false })))
      .toMatchObject({ ok: false, code: 'UPLOADS_DISABLED', status: 403 });
  });
  it('410s when the upload window has passed', () => {
    expect(transferService.assertUploadable(make({ allow_uploads: true, upload_expires_at: new Date(Date.now() - HOUR) })))
      .toMatchObject({ ok: false, code: 'UPLOAD_EXPIRED', status: 410 });
  });
});
