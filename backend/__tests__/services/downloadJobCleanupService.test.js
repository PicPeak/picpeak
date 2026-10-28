jest.mock('../../src/services/downloadJobService', () => ({ sweepExpired: jest.fn() }));
jest.mock('../../src/services/downloadJobNotifier', () => ({ retryUnsent: jest.fn() }));
jest.mock('../../src/services/scheduledTask', () => ({
  scheduledTask: () => ({ start: jest.fn(), stop: jest.fn() }),
}));
jest.mock('../../src/utils/logger', () => ({ error: jest.fn() }));

const { sweepExpired } = require('../../src/services/downloadJobService');
const { retryUnsent } = require('../../src/services/downloadJobNotifier');
const { runDownloadJobCleanup } = require('../../src/services/downloadJobCleanupService');

beforeEach(() => {
  jest.resetAllMocks();
  sweepExpired.mockResolvedValue(0);
  retryUnsent.mockResolvedValue(0);
});

it('retries ready notifications even when the archive sweep fails', async () => {
  sweepExpired.mockRejectedValue(new Error('Database temporarily unavailable'));
  await expect(runDownloadJobCleanup()).resolves.toBeUndefined();
  expect(retryUnsent).toHaveBeenCalledTimes(1);
});

it('contains a notification retry failure so the next cleanup can run', async () => {
  retryUnsent.mockRejectedValueOnce(new Error('Mail queue unavailable'));
  await expect(runDownloadJobCleanup()).resolves.toBeUndefined();
  await expect(runDownloadJobCleanup()).resolves.toBeUndefined();
  expect(sweepExpired).toHaveBeenCalledTimes(2);
  expect(retryUnsent).toHaveBeenCalledTimes(2);
});
