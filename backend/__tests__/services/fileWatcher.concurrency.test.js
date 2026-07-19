/**
 * Regression tests for the file-watcher concurrency bound.
 *
 * chokidar fires 'add' once per file — with no ignoreInitial option the boot
 * scan fires it for every existing file, and a bulk drop fires it for every
 * new one at once. Unbounded handlers each run DB lookups plus a full sharp
 * pipeline (sharp.concurrency(2) only caps libvips threads WITHIN one
 * operation), which can OOM small hosts. Both 'add' and 'unlink' must go
 * through the shared p-limit gate.
 *
 * Adapted from the filpgame fork (426ca491), extended to cover 'unlink'.
 */

const mockLimit = jest.fn((operation) => Promise.resolve().then(operation));
const mockPLimit = jest.fn(() => mockLimit);
const mockHandlers = {};
const mockWatcher = {
  on: jest.fn((event, handler) => {
    mockHandlers[event] = handler;
    return mockWatcher;
  }),
};

// Shared instances captured by the mock factories: jest.isolateModules re-runs
// each factory in a fresh registry, so the factories must return these same
// objects for the test to observe calls made inside the isolated module.
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
// Chainable no-row query — enough for removePhoto's lookup/delete calls.
const mockDb = jest.fn(() => ({
  where: jest.fn().mockReturnThis(),
  first: jest.fn().mockResolvedValue(null),
  delete: jest.fn().mockResolvedValue(0),
}));

jest.mock('p-limit', () => mockPLimit);
jest.mock('chokidar', () => ({
  watch: jest.fn(() => mockWatcher),
}));
jest.mock('../../src/database/db', () => ({ db: mockDb }));
jest.mock('../../src/utils/logger', () => mockLogger);
jest.mock('../../src/services/imageProcessor', () => ({
  generateThumbnail: jest.fn(),
  generateVideoPlaceholder: jest.fn(),
}));
jest.mock('../../src/services/videoProcessor', () => ({
  isVideoMimeType: jest.fn(() => false),
}));
jest.mock('../../src/services/downloadZipService', () => ({ invalidate: jest.fn() }));
jest.mock('../../src/utils/dbCompat', () => ({
  formatBoolean: jest.fn((value) => value),
}));

const loadFileWatcher = () => {
  let fileWatcher;
  jest.isolateModules(() => {
    fileWatcher = require('../../src/services/fileWatcher');
  });
  return fileWatcher;
};

describe('fileWatcher concurrency bound', () => {
  const originalBackend = process.env.STORAGE_BACKEND;
  const originalConcurrency = process.env.FILE_WATCHER_CONCURRENCY;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockHandlers).forEach((key) => delete mockHandlers[key]);
    process.env.STORAGE_BACKEND = 'local';
    delete process.env.FILE_WATCHER_CONCURRENCY;
  });

  afterAll(() => {
    if (originalBackend === undefined) delete process.env.STORAGE_BACKEND;
    else process.env.STORAGE_BACKEND = originalBackend;
    if (originalConcurrency === undefined) delete process.env.FILE_WATCHER_CONCURRENCY;
    else process.env.FILE_WATCHER_CONCURRENCY = originalConcurrency;
  });

  it.each([
    [undefined, 2],   // default
    ['3', 3],         // explicit
    ['0', 1],         // floored to 1
    ['-4', 1],        // floored to 1
    ['invalid', 2],   // falls back to default
  ])('configures the limiter with FILE_WATCHER_CONCURRENCY=%s as %i', (configured, expected) => {
    if (configured === undefined) delete process.env.FILE_WATCHER_CONCURRENCY;
    else process.env.FILE_WATCHER_CONCURRENCY = configured;

    loadFileWatcher().startFileWatcher();

    expect(mockPLimit).toHaveBeenCalledWith(expected);
  });

  it('routes add events through the shared limiter', async () => {
    loadFileWatcher().startFileWatcher();

    expect(mockHandlers.add).toEqual(expect.any(Function));
    mockHandlers.add('/outside-watch-root'); // early-returns inside processNewPhoto

    expect(mockLimit).toHaveBeenCalledTimes(1);
    expect(mockLimit).toHaveBeenCalledWith(expect.any(Function));
    await mockLimit.mock.results[0].value;
  });

  it('routes unlink events through the same limiter', async () => {
    loadFileWatcher().startFileWatcher();

    expect(mockHandlers.unlink).toEqual(expect.any(Function));
    mockHandlers.unlink('/outside-watch-root'); // early-returns inside removePhoto

    expect(mockLimit).toHaveBeenCalledTimes(1);
    await mockLimit.mock.results[0].value;
  });

  it('logs instead of rejecting when a queued handler throws', async () => {
    loadFileWatcher().startFileWatcher();

    const failure = new Error('boom');
    mockLimit.mockImplementationOnce(() => Promise.reject(failure));
    mockHandlers.add('/whatever');

    await new Promise(process.nextTick);
    expect(mockLogger.error).toHaveBeenCalledWith('Error processing new photo:', failure);
  });
});
