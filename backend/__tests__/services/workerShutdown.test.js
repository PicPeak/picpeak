jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe.each(['backgroundProcessor', 'faceQueue'])('%s shutdown', name => {
  let worker, db, processPhoto, featureEnabled, janitorUpdate, releases;
  const prefix = name === 'faceQueue' ? 'FACE_PROCESSOR' : 'UPLOAD_PROCESSOR';
  let previousEnv;
  class SidecarUnavailableError extends Error {}

  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    releases.push(resolve);
    return { promise, resolve };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    releases = [];
    previousEnv = { ...process.env };
    delete process.env[`${prefix}_DISABLED`];
    process.env[`${prefix}_CONCURRENCY`] = '2';
    process.env[`${prefix}_POLL_MS`] = '2000';
    process.env.FACE_PROCESSOR_BACKOFF_MS = '30000';
    processPhoto = jest.fn().mockResolvedValue({ status: 'skipped' });
    featureEnabled = jest.fn().mockResolvedValue(true);
    janitorUpdate = jest.fn().mockResolvedValue(0);
    const chain = { where: jest.fn().mockReturnThis(), update: janitorUpdate, first: jest.fn().mockResolvedValue(null) };
    db = jest.fn(() => chain);
    db.client = { config: { client: 'pg' } };
    // Claims and processing are controlled at the I/O boundary; the real
    // workers, janitors, idle sleeps and stopServices run in every test.
    db.transaction = jest.fn().mockResolvedValue(null);
    jest.doMock('../../src/database/db', () => ({ db }));
    jest.doMock('../../src/services/photoProcessor', () => ({ processPhoto }));
    jest.doMock('../../src/services/mediaAttemptService', () => ({
      claimNext: () => db.transaction(), execute: (_photo, _kind, callback) => callback(),
      recover: () => janitorUpdate(), cancel: jest.fn(), assertDrained: jest.fn(),
    }));
    jest.doMock('../../src/services/faceProcessor', () => ({
      processPhotoFaces: processPhoto, TransientSourceError: class extends Error {},
    }));
    jest.doMock('../../src/services/faceClient', () => ({ SidecarUnavailableError }));
    jest.doMock('../../src/services/faceSettings', () => ({
      isFeatureEnabled: featureEnabled, isEnabledForEvent: jest.fn().mockResolvedValue(false),
    }));
    worker = require(`../../src/services/${name}`);
  });

  afterEach(async () => {
    releases.forEach(resolve => resolve());
    const stopped = worker.stop();
    // Also cleans up the original, non-interruptible implementation when a
    // regression assertion fails; the test never needs to wait a real minute.
    await jest.advanceTimersByTimeAsync(60000);
    await stopped;
    jest.useRealTimers();
    process.env = previousEnv;
  });

  async function expectPromptStop(stop = () => worker.stop()) {
    let done = false;
    const stopped = stop().then(() => { done = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await stopped;
  }

  it('wakes all idle workers and the minute-long janitor through stopServices', async () => {
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(3);
    // Confirm normal polling still runs before shutdown.
    await jest.advanceTimersByTimeAsync(2000);
    expect(db.transaction).toHaveBeenCalledTimes(4);
    await expectPromptStop(() => require('../../src/services/serviceShutdown').stopServices());
  });

  it('wakes claim-error backoff and can start a fresh run after stopping', async () => {
    db.transaction.mockRejectedValue(new Error('database unavailable'));
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    await expectPromptStop();
    db.transaction.mockResolvedValue(null);
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(3);
    await expectPromptStop();
  });

  it('drains active processing for every stop caller and prevents overlapping restarts', async () => {
    const processing = deferred();
    processPhoto.mockReturnValue(processing.promise);
    db.transaction.mockResolvedValueOnce({ id: 1 });
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(processPhoto).toHaveBeenCalledWith(1);
    let done = false;
    const first = worker.stop();
    expect(worker.stop()).toBe(first);
    first.then(() => { done = true; });
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    processing.resolve({ status: 'skipped' });
    await expectPromptStop();
    expect(done).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('drains a claim already in flight without starting another poll', async () => {
    const claim = deferred();
    db.transaction.mockReturnValueOnce(claim.promise);
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    const stopped = worker.stop();
    claim.resolve({ id: 2 });
    await expectPromptStop(() => stopped);
    expect(processPhoto).toHaveBeenCalledWith(2);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('does not schedule new waits when pending database work finishes after stop', async () => {
    const claim = deferred();
    const janitor = deferred();
    db.transaction.mockReturnValue(claim.promise);
    janitorUpdate.mockReturnValue(janitor.promise);
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    let done = false;
    const stopped = worker.stop().then(() => { done = true; });
    claim.resolve(null);
    await jest.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    janitor.resolve(0);
    await expectPromptStop(() => stopped);
  });

  if (name === 'faceQueue') {
    it('interrupts the ten-second sleep with faces disabled by default', async () => {
      featureEnabled.mockResolvedValue(false);
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(3);
      await expectPromptStop();
    });

    it('releases a claimed photo and interrupts the sidecar outage backoff', async () => {
      db.transaction.mockResolvedValueOnce({ id: 3, event_id: 5 });
      processPhoto.mockRejectedValue(new SidecarUnavailableError('offline'));
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(janitorUpdate).toHaveBeenCalledWith({ face_status: 'pending', face_started_at: null });
      await expectPromptStop();
      expect(worker.inFlightByEvent.size).toBe(0);
    });

    it('does not claim new work after a pending feature check resolves during shutdown', async () => {
      const feature = deferred();
      featureEnabled.mockReturnValue(feature.promise);
      worker.start();
      const stopped = worker.stop();
      feature.resolve(true);
      await expectPromptStop(() => stopped);
      expect(db.transaction).not.toHaveBeenCalled();
    });
  }
});
