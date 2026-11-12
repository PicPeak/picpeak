/**
 * Background zip rebuilds are capped (#1399).
 *
 * invalidateAll() invalidates every event holding a cached zip, and each
 * invalidate() arms its own debounce timer in the same tick — so they all fire
 * together. Every build opens its own storage reads, so a settings change
 * across 25 events was enough to exhaust the S3 agent pool and stall uploads,
 * thumbnails and gallery reads until the burst drained.
 *
 * The cap is on the BACKGROUND path only: a guest waiting on a download must
 * not be queued behind a settings-change burst.
 */
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { db } = require('../../src/database/db');
const service = require('../../src/services/downloadZipService');

const flush = () => new Promise((r) => setImmediate(r));

describe('downloadZipService background regen concurrency (#1399)', () => {
  let peak;
  let inFlight;
  let release;

  beforeEach(() => {
    // setImmediate must stay real: the flush() helper below rides on it, and
    // jest's modern fake timers mock it too.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    peak = 0;
    inFlight = 0;
    release = [];
    service.stopped = false;
    service.regenActive = 0;
    service.regenWaiters = [];
    service.debounceTimers.clear();
    service.activeBuilds.clear();

    jest.spyOn(service, 'generateZip').mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        release.push(() => { inFlight -= 1; resolve(); });
      });
    });
    jest.spyOn(service, '_cleanup').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('never runs more than two rebuilds at once, however many fire together', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }));
    db.mockReturnValue({
      whereNotNull: () => ({ select: () => Promise.resolve(rows) }),
    });

    await service.invalidateAll();
    // Every debounce timer was armed in the same tick — fire them all.
    jest.runAllTimers();
    await flush();

    expect(peak).toBe(2);
    expect(service.generateZip).toHaveBeenCalledTimes(2);
  });

  it('starts the next rebuild as each one finishes', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    db.mockReturnValue({
      whereNotNull: () => ({ select: () => Promise.resolve(rows) }),
    });

    await service.invalidateAll();
    jest.runAllTimers();
    await flush();
    expect(service.generateZip).toHaveBeenCalledTimes(2);

    release.shift()();
    await flush();
    expect(service.generateZip).toHaveBeenCalledTimes(3);
    expect(peak).toBe(2);

    while (release.length) { release.shift()(); await flush(); }
    expect(service.generateZip).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it('does not queue a foreground download behind the burst', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    db.mockReturnValue({
      whereNotNull: () => ({ select: () => Promise.resolve(rows) }),
    });

    await service.invalidateAll();
    jest.runAllTimers();
    await flush();
    expect(service.generateZip).toHaveBeenCalledTimes(2);

    // A guest asking for a zip right now calls generateZip directly. It must
    // not park behind the two rebuilds already holding the slots.
    service.generateZip(999);
    await flush();
    expect(service.generateZip).toHaveBeenCalledWith(999);
    expect(inFlight).toBe(3);
  });

  it('does not start a queued rebuild once ZIP builds are paused, and lets running ones end', async () => {
    const health = require('../../src/services/dependencyHealth');
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    db.mockReturnValue({
      whereNotNull: () => ({ select: () => Promise.resolve(rows) }),
    });

    await service.invalidateAll();
    jest.runAllTimers();
    await flush();
    expect(service.generateZip).toHaveBeenCalledTimes(2);

    health.forcedOff = ['downloads.archive'];
    try {
      while (release.length) { release.shift()(); await flush(); }
      expect(service.generateZip).toHaveBeenCalledTimes(2);
      expect(service.regenWaiters).toHaveLength(0);
      expect(service.regenActive).toBe(0);
    } finally {
      health.forcedOff = [];
    }
  });

  it('releases anything parked for a slot on shutdown', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    db.mockReturnValue({
      whereNotNull: () => ({ select: () => Promise.resolve(rows) }),
    });

    await service.invalidateAll();
    jest.runAllTimers();
    await flush();
    expect(service.regenWaiters.length).toBeGreaterThan(0);

    // stop() must not hang on a queue that will never drain.
    const stopping = service.stop();
    release.forEach((fn) => fn());
    await expect(stopping).resolves.toBeUndefined();
    expect(service.regenWaiters).toHaveLength(0);
  });
});
