/**
 * videoRenditionQueue.claimNext: the claim itself (SKIP LOCKED on Postgres, a
 * status-guarded UPDATE on SQLite, the attempt id and limit) is the shared
 * one in mediaAttemptService, exercised against a real database in
 * __tests__/integration/mediaAttempts.test.js. Here: what this queue does
 * with it.
 */

jest.mock('../../src/services/videoRenditionService', () => ({
  queuesVideos: jest.fn(),
  renderWebCopy: jest.fn(),
  queueForMetadataStrip: jest.fn(async () => 0),
  requeueStranded: jest.fn(async () => 0),
}));
jest.mock('../../src/services/mediaProcessService', () => ({ start: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/database/db', () => ({ db: Object.assign(jest.fn(), { client: { config: { client: 'sqlite3' } } }) }));
jest.mock('../../src/services/mediaAttemptService', () => ({ MAX_ATTEMPTS: 5, claimNext: jest.fn(), execute: jest.fn(), recover: jest.fn(), cancel: jest.fn(), assertDrained: jest.fn() }));

describe('videoRenditionQueue.claimNext', () => {
  const mediaAttempts = require('../../src/services/mediaAttemptService');
  const queue = require('../../src/services/videoRenditionQueue');
  beforeEach(() => jest.clearAllMocks());

  it('returns null when nothing is pending', async () => {
    mediaAttempts.claimNext.mockResolvedValue(null);
    expect(await queue.claimNext()).toBeNull();
    expect(mediaAttempts.claimNext).toHaveBeenCalledWith('web');
  });

  it('returns the claimed row with its attempt id', async () => {
    const row = { id: 42, web_status: 'processing', web_attempt_id: 'a', web_started_at: new Date().toISOString() };
    mediaAttempts.claimNext.mockResolvedValue(row);
    expect(await queue.claimNext()).toBe(row);
  });

  it('claims nothing for a video that used up its attempts', async () => {
    mediaAttempts.claimNext.mockResolvedValue({ exhausted: 7 });
    expect(await queue.claimNext()).toBeNull();
  });
});

describe('videoRenditionQueue.start', () => {
  const service = require('../../src/services/videoRenditionService');
  const mediaAttempts = require('../../src/services/mediaAttemptService');
  const queue = require('../../src/services/videoRenditionQueue');
  afterEach(async () => { await queue.stop(); jest.clearAllMocks(); });

  it('runs the workers while any video setting is on (metadata stripping alone included) and backfills once', async () => {
    // queuesVideos answers for both settings; true here stands for
    // "web copies off, stripping on" (issue 2102).
    service.queuesVideos.mockResolvedValue(true);
    mediaAttempts.claimNext.mockResolvedValue(null);
    mediaAttempts.recover.mockResolvedValue(0);
    mediaAttempts.assertDrained.mockResolvedValue();
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.queuesVideos).toHaveBeenCalled();
    expect(mediaAttempts.claimNext).toHaveBeenCalledWith('web');
    expect(service.queueForMetadataStrip).toHaveBeenCalledTimes(1);
    // The janitor's first tick re-queues rows stranded by a setting change.
    expect(service.requeueStranded).toHaveBeenCalled();
  });

  it('claims nothing while both settings are off', async () => {
    service.queuesVideos.mockResolvedValue(false);
    mediaAttempts.recover.mockResolvedValue(0);
    mediaAttempts.assertDrained.mockResolvedValue();
    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mediaAttempts.claimNext).not.toHaveBeenCalled();
  });
});
