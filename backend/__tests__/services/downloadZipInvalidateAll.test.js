/**
 * invalidateAll() must reach a zip that is still building (issue 1733).
 *
 * It selected the events holding a cached zip, but a FIRST build in flight
 * has no download_zip_path yet. Its version was never bumped, the build's own
 * version checks passed, and it published a zip made under the settings that
 * had just been changed.
 */
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { db } = require('../../src/database/db');
const service = require('../../src/services/downloadZipService');

describe('downloadZipService.invalidateAll with a build in flight (issue 1733)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    service.stopped = false;
    service.debounceTimers.clear();
    service.activeBuilds.clear();
    service.versions.clear();
    service.buildCancellers.clear();
    jest.spyOn(service, 'invalidate');
    jest.spyOn(service, '_cleanup').mockResolvedValue(undefined);
  });

  afterEach(() => {
    // The parked builds never settle; stop() in jest.setup's afterAll would
    // wait on them forever.
    service.activeBuilds.clear();
    service.buildCancellers.clear();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('bumps the version of a first build that has no cached zip row yet', async () => {
    // Event 7 is building for the first time: registered in activeBuilds,
    // nothing in download_zip_path, so the query cannot return it.
    service.versions.set(7, 1);
    service.activeBuilds.set(7, { promise: new Promise(() => {}), version: 1 });
    const cancel = jest.fn();
    service.buildCancellers.set(7, cancel);
    db.mockReturnValue({
      whereNotNull: () => ({ select: () => Promise.resolve([{ id: 1 }]) }),
    });

    await service.invalidateAll();

    expect(service.invalidate).toHaveBeenCalledWith(7);
    expect(service.versions.get(7)).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(service.invalidate).toHaveBeenCalledWith(1);
  });

  it('invalidates an event only once when it is both cached and rebuilding', async () => {
    service.versions.set(3, 4);
    service.activeBuilds.set(3, { promise: new Promise(() => {}), version: 4 });
    db.mockReturnValue({
      whereNotNull: () => ({ select: () => Promise.resolve([{ id: 3 }]) }),
    });

    await service.invalidateAll();

    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(service.versions.get(3)).toBe(5);
  });

  it('starts a fresh build when the active one was invalidated mid-flight', async () => {
    // The debounced regeneration lands while the stale build is still
    // uploading; reusing that promise would publish nothing new.
    service.versions.set(5, 2);
    const stale = new Promise(() => {});
    service.activeBuilds.set(5, { promise: stale, version: 1 });
    const build = jest.spyOn(service, '_build').mockResolvedValue({ success: true });

    const result = await service.generateZip(5);

    expect(build).toHaveBeenCalledWith(5, 3);
    expect(result).toEqual({ success: true });
  });

  it('still shares one in-flight build while its version is current', async () => {
    service.versions.set(6, 1);
    const current = Promise.resolve({ success: true, key: 'k' });
    service.activeBuilds.set(6, { promise: current, version: 1 });
    const build = jest.spyOn(service, '_build');

    expect(await service.generateZip(6)).toEqual({ success: true, key: 'k' });
    expect(build).not.toHaveBeenCalled();
  });
});
