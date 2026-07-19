/**
 * Locks the process-wide Sharp memory guards. The file-watcher concurrency
 * bound (FILE_WATCHER_CONCURRENCY) assumes these caps stay in place — they
 * limit libvips threads/cache WITHIN one operation while p-limit bounds the
 * number of parallel pipelines. From the filpgame fork (426ca491).
 */

const mockSharp = jest.fn();
mockSharp.cache = jest.fn();
mockSharp.concurrency = jest.fn();

jest.mock('sharp', () => mockSharp);

jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

describe('imageProcessor Sharp configuration', () => {
  it('disables the Sharp cache and caps libvips concurrency', () => {
    jest.isolateModules(() => {
      require('../../src/services/imageProcessor');
    });

    expect(mockSharp.cache).toHaveBeenCalledWith(false);
    expect(mockSharp.concurrency).toHaveBeenCalledWith(2);
  });
});
