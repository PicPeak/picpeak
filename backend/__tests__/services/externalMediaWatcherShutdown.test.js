describe('external media watcher shutdown ownership', () => {
  let watcher;
  let imported;
  let database;
  let closed;
  let releases;

  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    releases.push(resolve);
    return { promise, resolve };
  }

  beforeEach(() => {
    jest.resetModules();
    releases = [];
    imported = jest.fn().mockResolvedValue({ imported: 0, deferred: 0 });
    closed = jest.fn().mockResolvedValue(undefined);
    const event = { id: 7, slug: 'watch', external_watch: 1, source_mode: 'reference',
      external_path: 'nas', is_active: 1, is_archived: 0 };
    const query = { where: jest.fn().mockReturnThis(), whereNotNull: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([event]), first: jest.fn().mockResolvedValue(event) };
    database = jest.fn(() => query);
    jest.doMock('../../src/database/db', () => ({ db: database }));
    jest.doMock('../../src/utils/logger', () => ({
      info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    jest.doMock('../../src/services/externalMediaService', () => ({ resolveExternalPath: () => '/fixture/nas' }));
    jest.doMock('../../src/services/externalImportService', () => ({
      importExternalFolder: imported, ImportInProgressError: class extends Error {},
      IMAGE_EXTENSIONS: ['.jpg'], VIDEO_EXTENSIONS: ['.mp4'],
    }));
    jest.doMock('fs', () => ({ promises: { stat: jest.fn().mockResolvedValue({ isDirectory: () => true }) } }));
    jest.doMock('chokidar', () => ({ watch: () => {
      const handle = { close: closed, on: jest.fn(() => handle) };
      return handle;
    } }));
    watcher = require('../../src/services/externalMediaWatcher');
  });

  afterEach(async () => {
    releases.forEach(resolve => resolve({ imported: 0, deferred: 0 }));
    await watcher.stopExternalMediaWatcher();
  });

  it('waits for an active import and gives concurrent callers the same drain promise', async () => {
    const gate = deferred();
    imported.mockReturnValue(gate.promise);
    const running = watcher.runImport(7, 'change');
    await Promise.resolve();
    let finished = false;
    const stopped = watcher.stopExternalMediaWatcher();
    expect(watcher.stopExternalMediaWatcher()).toBe(stopped);
    stopped.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(watcher.startExternalMediaWatcher()).toBeNull();
    expect(await watcher.runImport(7, 'change')).toBeNull();
    expect(imported).toHaveBeenCalledTimes(1);
    gate.resolve({ imported: 1, deferred: 0 });
    await Promise.all([running, stopped]);
    expect(finished).toBe(true);
    expect(await watcher.runImport(7, 'manual')).toEqual({ imported: 1, deferred: 0 });
  });

  it('cannot start a watcher after a pending reconciliation resolves during shutdown', async () => {
    const gate = deferred();
    database().select.mockReturnValue(gate.promise);
    const reconciling = watcher.reconcile();
    const stopped = watcher.stopExternalMediaWatcher();
    gate.resolve([{ id: 7, slug: 'watch', external_path: 'nas' }]);
    await Promise.all([reconciling, stopped]);
    expect(watcher.watchedEventIds()).toEqual([]);
    expect(imported).not.toHaveBeenCalled();
  });

  it('owns the startup reconciliation until its nested import has finished', async () => {
    const gate = deferred();
    imported.mockReturnValue(gate.promise);
    watcher.startExternalMediaWatcher();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(imported).toHaveBeenCalledTimes(1);
    let finished = false;
    const stopped = watcher.stopExternalMediaWatcher().then(() => { finished = true; });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve({ imported: 0, deferred: 1 });
    await stopped;
    expect(watcher.watchedEventIds()).toEqual([]);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
