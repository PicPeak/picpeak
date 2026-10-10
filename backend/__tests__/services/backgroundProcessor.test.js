/**
 * Unit tests for backgroundProcessor.claimNextPhoto.
 *
 * The claim itself (SKIP LOCKED on Postgres, the status-guarded UPDATE on
 * SQLite, the due time, the attempt limit) lives in mediaAttemptService and
 * is exercised against a real database in
 * __tests__/integration/mediaAttempts.test.js and
 * backgroundProcessorRetry.test.js. Here: what the photo queue does with it.
 */

jest.mock('../../src/services/photoProcessor', () => ({
  processPhoto: jest.fn(),
  processUploadedPhotos: jest.fn(),
  queueFilesForProcessing: jest.fn(),
}));
jest.mock('../../src/database/db', () => ({ db: Object.assign(jest.fn(), { client: { config: { client: 'sqlite3' } } }) }));
jest.mock('../../src/services/mediaAttemptService', () => ({ MAX_ATTEMPTS: 5, claimNext: jest.fn(), execute: jest.fn(), recover: jest.fn(), cancel: jest.fn() }));
jest.mock('../../src/services/publicUploadQuota', () => ({ releasePending: jest.fn(async () => {}) }));

const mediaAttempts = require('../../src/services/mediaAttemptService');
const publicUploadQuota = require('../../src/services/publicUploadQuota');
const bg = require('../../src/services/backgroundProcessor');

describe('backgroundProcessor.claimNextPhoto', () => {
  beforeEach(() => jest.clearAllMocks());

  it('claims the next photo through the shared attempt claim', async () => {
    const row = { id: 42, processing_status: 'processing', processing_attempt_id: 'a', processing_attempts: 1 };
    mediaAttempts.claimNext.mockResolvedValue(row);
    expect(await bg.claimNextPhoto()).toBe(row);
    expect(mediaAttempts.claimNext).toHaveBeenCalledWith('photo');
  });

  it('returns null when there are no pending photos', async () => {
    mediaAttempts.claimNext.mockResolvedValue(null);
    expect(await bg.claimNextPhoto()).toBeNull();
    expect(publicUploadQuota.releasePending).not.toHaveBeenCalled();
  });

  it('frees the pending upload hold of a photo that used up its attempts, and claims nothing', async () => {
    mediaAttempts.claimNext.mockResolvedValue({ exhausted: 7 });
    expect(await bg.claimNextPhoto()).toBeNull();
    expect(publicUploadQuota.releasePending).toHaveBeenCalledWith(7);
  });
});
