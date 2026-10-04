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
    service.pendingCleanups.clear();
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

  it('starts a fresh build once the invalidated one has settled, never alongside it', async () => {
    // The debounced regeneration lands while the stale build is still
    // uploading; reusing that promise would publish nothing new, and
    // overlapping it would let its discard delete the replacement's zip.
    service.versions.set(5, 2);
    let settleStale;
    const stale = new Promise((resolve) => { settleStale = resolve; });
    service.activeBuilds.set(5, { promise: stale, version: 1 });
    const build = jest.spyOn(service, '_build').mockResolvedValue({ success: true });

    const pending = service.generateZip(5);
    await Promise.resolve();
    expect(build).not.toHaveBeenCalled();

    settleStale({ success: false, error: 'Build invalidated' });
    const result = await pending;

    expect(build).toHaveBeenCalledWith(5, 3);
    expect(result).toEqual({ success: true });
  });

  it('starts nothing when the service stopped while it waited for the stale build', async () => {
    service.versions.set(9, 2);
    let settleStale;
    const stale = new Promise((resolve) => { settleStale = resolve; });
    service.activeBuilds.set(9, { promise: stale, version: 1 });
    const build = jest.spyOn(service, '_build').mockResolvedValue({ success: true });

    const pending = service.generateZip(9);
    service.stopped = true;
    settleStale({ success: false, error: 'Build invalidated' });

    expect(await pending).toEqual({ success: false, error: 'Service stopped' });
    expect(build).not.toHaveBeenCalled();
    expect(service.activeBuilds.has(9)).toBe(false);
  });

  it('waits for invalidate()\'s cleanup before the replacement build starts', async () => {
    // A cleanup still pending when the new build publishes would delete the
    // shared key and clear the row of the fresh zip.
    let finishCleanup;
    service._cleanup.mockImplementation(() => new Promise((resolve) => { finishCleanup = resolve; }));
    const build = jest.spyOn(service, '_build').mockResolvedValue({ success: true });

    service.invalidate(4);
    expect(service.pendingCleanups.has(4)).toBe(true);
    const pending = service.generateZip(4);
    await Promise.resolve();
    await Promise.resolve();
    expect(build).not.toHaveBeenCalled();

    finishCleanup();
    expect(await pending).toEqual({ success: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(service.pendingCleanups.has(4)).toBe(false);
  });

  it('still shares one in-flight build while its version is current', async () => {
    service.versions.set(6, 1);
    const current = Promise.resolve({ success: true, key: 'k' });
    service.activeBuilds.set(6, { promise: current, version: 1 });
    const build = jest.spyOn(service, '_build');

    expect(await service.generateZip(6)).toEqual({ success: true, key: 'k' });
    expect(build).not.toHaveBeenCalled();
  });

  it('still invalidates a first-time build that finishes while the cached-row query runs', async () => {
    // The build publishes its row and leaves activeBuilds during the SELECT:
    // the query read the row before the write, so afterwards the event is in
    // neither set unless the active keys were taken first.
    service.versions.set(8, 1);
    service.activeBuilds.set(8, { promise: new Promise(() => {}), version: 1 });
    db.mockReturnValue({
      whereNotNull: () => ({
        select: async () => {
          service.activeBuilds.delete(8);
          return [];
        },
      }),
    });

    await service.invalidateAll();

    expect(service.invalidate).toHaveBeenCalledWith(8);
    expect(service.versions.get(8)).toBe(2);
  });

  it('takes the published row back when the version moved during stat or the row write', () => {
    // Pinned at source level: _build needs archiver, storage and a real photo
    // set to run. The recheck must sit after the row write and before the
    // success return, and must clear the row only while it still points at
    // this build's key.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/services/downloadZipService.js'), 'utf8');
    const write = src.indexOf("download_zip_generated_at: new Date(),");
    const recheck = src.indexOf('if (this.versions.get(eventId) !== version)', write);
    const success = src.indexOf("return { success: true, key: finalKey", write);
    expect(write).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(write);
    expect(recheck).toBeLessThan(success);
    const block = src.slice(recheck, success);
    expect(block).toContain(".where({ id: eventId, download_zip_path: finalKey })");
    expect(block).toContain('download_zip_path: null, download_zip_generated_at: null');
    expect(block).toContain('storage.delete(finalKey)');
  });
});
