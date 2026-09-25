/**
 * The watcher's write-finish window (how long a new file must stop growing
 * before it is imported, and how often that is checked) is tunable through
 * FILE_WATCHER_STABILITY_MS and FILE_WATCHER_POLL_INTERVAL_MS, parsed like the
 * concurrency bound: a positive integer, or the default with a warning.
 */
const mockLimit = jest.fn((operation) => Promise.resolve().then(operation));
const mockPLimit = jest.fn(() => mockLimit);
const mockWatcher = { on: jest.fn(() => mockWatcher) };
const mockWatch = jest.fn(() => mockWatcher);
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
const mockDb = jest.fn(() => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null), delete: jest.fn().mockResolvedValue(0) }));

jest.mock('p-limit', () => mockPLimit);
jest.mock('chokidar', () => ({ watch: mockWatch }));
jest.mock('../../src/database/db', () => ({ db: mockDb }));
jest.mock('../../src/utils/logger', () => mockLogger);
jest.mock('../../src/services/imageProcessor', () => ({ generateThumbnail: jest.fn(), generateVideoPlaceholder: jest.fn() }));
jest.mock('../../src/services/videoProcessor', () => ({ isVideoMimeType: jest.fn(() => false) }));
jest.mock('../../src/services/downloadZipService', () => ({ invalidate: jest.fn() }));
jest.mock('../../src/utils/dbCompat', () => ({ formatBoolean: jest.fn((value) => value) }));

const VARS = ['FILE_WATCHER_STABILITY_MS', 'FILE_WATCHER_POLL_INTERVAL_MS'];
const saved = {};
const loadAndStart = () => {
  jest.isolateModules(() => { require('../../src/services/fileWatcher').startFileWatcher(); });
  return mockWatch.mock.calls[mockWatch.mock.calls.length - 1][1].awaitWriteFinish;
};

beforeAll(() => { for (const v of VARS) saved[v] = process.env[v]; });
beforeEach(() => { jest.clearAllMocks(); process.env.STORAGE_BACKEND = 'local'; for (const v of VARS) delete process.env[v]; });
afterAll(() => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } });

it('keeps chokidar\'s previous window when nothing is configured', () => {
  expect(loadAndStart()).toEqual({ stabilityThreshold: 2000, pollInterval: 100 });
  expect(mockLogger.warn).not.toHaveBeenCalled();
});

it('reads both values from the environment', () => {
  process.env.FILE_WATCHER_STABILITY_MS = '15000';
  process.env.FILE_WATCHER_POLL_INTERVAL_MS = '500';
  expect(loadAndStart()).toEqual({ stabilityThreshold: 15000, pollInterval: 500 });
});

it.each([['0'], ['-5'], ['soon'], ['1.5x']])('falls back to the default with a warning for %s', (value) => {
  process.env.FILE_WATCHER_STABILITY_MS = value;
  const options = loadAndStart();
  expect(options.stabilityThreshold).toBe(2000);
  expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('FILE_WATCHER_STABILITY_MS'));
});
