jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/appSettings', () => ({ getAppSetting: jest.fn(), upsertAppSetting: jest.fn() }));

const { getAppSetting, upsertAppSetting } = require('../../src/utils/appSettings');
const dependencyHealth = require('../../src/services/dependencyHealth');

const { DependencyHealth, diskState, TRIP_AFTER, DOWN_AFTER, RECOVER_AFTER } = dependencyHealth;
const GIB = 1024 ** 3;

function build(probes) {
  return new DependencyHealth({ probes });
}

async function ticks(health, count) {
  for (let i = 0; i < count; i += 1) await health.tick();
}

beforeEach(() => {
  getAppSetting.mockReset();
  getAppSetting.mockImplementation(async (_key, fallback) => fallback);
});

describe('breaker transitions', () => {
  it('ignores one bad probe', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('blip')) });
    await ticks(health, TRIP_AFTER - 1);
    expect(health.states().storage).toBe('healthy');
  });

  it('degrades, then goes down on repeated failures', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, TRIP_AFTER);
    expect(health.states().storage).toBe('degraded');
    await ticks(health, DOWN_AFTER - TRIP_AFTER);
    expect(health.states().storage).toBe('down');
    // Fixed text: GET /status shows it, and an error can name a path or a host.
    expect(health.snapshot().dependencies.storage.detail).toBe('check failed');
  });

  it('never shows the error itself, which can name a local path', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EACCES: permission denied, access /home/someone/storage')) });
    await ticks(health, DOWN_AFTER);
    expect(JSON.stringify(health.snapshot())).not.toContain('/home/someone');
  });

  it('counts a probe that times out as slow, so a busy backend does not pause uploads', async () => {
    // Returns after the timeout but before the next pass, like S3 with a full
    // socket pool.
    const probe = jest.fn(() => new Promise((resolve) => { setTimeout(() => resolve({ state: 'healthy' }), 5500); }));
    const health = build({ storage: probe });
    const pass = async () => {
      const running = health.tick();
      await jest.advanceTimersByTimeAsync(6000);
      await running;
    };
    jest.useFakeTimers();
    try {
      for (let i = 0; i < DOWN_AFTER - 1; i += 1) await pass();
      expect(health.states().storage).toBe('healthy');
      await pass();
      expect(health.states().storage).toBe('degraded');
      for (let i = 0; i < DOWN_AFTER * 2; i += 1) await pass();
    } finally {
      jest.useRealTimers();
    }
    expect(health.states().storage).toBe('degraded');
    expect(health.snapshot().dependencies.storage.detail).toBe('check timed out');
  });

  it('gives a merely slow dependency longer, and never calls it down', async () => {
    const health = build({ storage: jest.fn().mockResolvedValue({ state: 'degraded', detail: 'slow', slow: true }) });
    await ticks(health, DOWN_AFTER - 1);
    expect(health.states().storage).toBe('healthy');
    await ticks(health, 1);
    expect(health.states().storage).toBe('degraded');
    await ticks(health, DOWN_AFTER * 2);
    expect(health.states().storage).toBe('degraded');
  });

  it('does not let one failure after slow readings take it down', async () => {
    const probe = jest.fn().mockResolvedValue({ state: 'degraded', detail: 'slow', slow: true });
    const health = build({ storage: probe });
    await ticks(health, DOWN_AFTER - 1);
    probe.mockRejectedValueOnce(new Error('timed out'));
    await ticks(health, 1);
    expect(health.states().storage).toBe('healthy');
  });

  it('does not let a bad reading improve the state', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('EIO'));
    const health = build({ storage: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockResolvedValueOnce({ state: 'healthy' });
    await ticks(health, 3);
    expect(health.states().storage).toBe('down');
    probe.mockResolvedValueOnce({ state: 'degraded', detail: 'slow', slow: true });
    await ticks(health, 1);
    expect(health.states().storage).toBe('down');
  });

  it('steps down to degraded only after a stable run of better readings', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('disk full'));
    const health = build({ disk: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockReset();
    probe.mockResolvedValue({ state: 'degraded' });
    await ticks(health, RECOVER_AFTER - 1);
    expect(health.states().disk).toBe('down');
    await ticks(health, 1);
    expect(health.states().disk).toBe('degraded');
  });

  it('does not stack a new probe on one that has not returned', async () => {
    const probe = jest.fn(() => new Promise(() => {}));
    const health = build({ storage: probe });
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 3; i += 1) {
        const pass = health.tick();
        await jest.advanceTimersByTimeAsync(6000);
        await pass;
      }
    } finally {
      jest.useRealTimers();
    }
    expect(probe).toHaveBeenCalledTimes(1);
    expect(health.snapshot().dependencies.storage.detail).toBe('previous check has not returned');
  });

  it('keeps checking when the settings read hangs', async () => {
    getAppSetting.mockImplementation(() => new Promise(() => {}));
    const health = build({ storage: jest.fn().mockResolvedValue({ state: 'healthy' }) });
    jest.useFakeTimers();
    try {
      const pass = health.tick();
      await jest.advanceTimersByTimeAsync(6000);
      await pass;
    } finally {
      jest.useRealTimers();
    }
    expect(health.running).toBeNull();
  });

  it('needs a stable run to recover, and a blip restarts it', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('EIO'));
    const health = build({ storage: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockReset();
    probe.mockResolvedValue({ state: 'healthy' });
    await ticks(health, RECOVER_AFTER - 1);
    expect(health.states().storage).toBe('down');
    probe.mockRejectedValueOnce(new Error('EIO'));
    await ticks(health, RECOVER_AFTER - 1 + 1);
    expect(health.states().storage).toBe('down');
    await ticks(health, 1);
    expect(health.states().storage).toBe('healthy');
  });

  it('recovers at once when an admin rechecks and the probe is good', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('EIO'));
    const health = build({ storage: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockReset();
    probe.mockResolvedValue({ state: 'healthy' });
    await health.recheck();
    expect(health.states().storage).toBe('healthy');
  });

  it('stays broken when a recheck still fails', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, DOWN_AFTER);
    await health.recheck();
    expect(health.states().storage).toBe('down');
  });

  it('leaves out a dependency that is not configured', async () => {
    const health = build({ faceSidecar: jest.fn().mockResolvedValue(null) });
    await ticks(health, 1);
    expect(health.snapshot().dependencies).toEqual({});
  });

  it('runs one pass at a time', async () => {
    let finish;
    const probe = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const health = build({ storage: probe });
    const first = health.tick();
    const second = health.tick();
    finish({ state: 'healthy' });
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('capabilities', () => {
  it('feeds breaker state into the decision', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, TRIP_AFTER);
    expect(health.evaluate('uploads.new')).toMatchObject({ available: false, paused: false, blockedBy: ['storage'] });
    expect(health.evaluate('downloads.archive').available).toBe(true);
  });

  it('pauses for real only when enforcing or forced', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, TRIP_AFTER);
    health.enforcement = 'enforce';
    expect(health.evaluate('uploads.new').paused).toBe(true);
    health.enforcement = 'observe';
    health.forcedOff = ['downloads.archive'];
    expect(health.evaluate('downloads.archive').paused).toBe(true);
  });

  it('drops unknown names from a stored override', async () => {
    getAppSetting.mockImplementation(async (key, fallback) => (
      key === dependencyHealth.FORCED_OFF_KEY ? ['uploads.new', 'auth.bypass'] : fallback
    ));
    const health = build({});
    await ticks(health, 1);
    expect(health.forcedOff).toEqual(['uploads.new']);
  });

  it('keeps the last settings when the database cannot be read', async () => {
    getAppSetting.mockImplementation(async (key, fallback) => (
      key === dependencyHealth.ENFORCEMENT_KEY ? 'enforce' : fallback
    ));
    const health = build({});
    await ticks(health, 1);
    getAppSetting.mockRejectedValue(new Error('db down'));
    await ticks(health, 1);
    expect(health.enforcement).toBe('enforce');
  });
});

describe('updateSettings', () => {
  it('never stores a name outside the catalog', async () => {
    const health = build({});
    await health.updateSettings({ forcedOff: ['uploads.new', 'auth.bypass'] });
    expect(upsertAppSetting).toHaveBeenCalledWith(dependencyHealth.FORCED_OFF_KEY, JSON.stringify(['uploads.new']), 'system');
  });
});

describe('disk probe', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('leaves out the disk for S3 without a local storage directory', async () => {
    process.env.STORAGE_BACKEND = 's3';
    process.env.STORAGE_PATH = '/nonexistent/picpeak-storage-for-test';
    await expect(dependencyHealth.probes.disk()).resolves.toBeNull();
  });

  it('still fails when the local storage directory is missing', async () => {
    process.env.STORAGE_BACKEND = 'local';
    process.env.STORAGE_PATH = '/nonexistent/picpeak-storage-for-test';
    await expect(dependencyHealth.probes.disk()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('temporary space probe', () => {
  const os = require('os');
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('is left out when the temporary directory is on the storage disk', async () => {
    process.env.STORAGE_PATH = os.tmpdir();
    await expect(dependencyHealth.probes.tempDisk()).resolves.toBeNull();
  });

  it('reads the temporary directory when it is a disk of its own', async () => {
    // /dev is its own filesystem on Linux and macOS alike.
    process.env.STORAGE_PATH = '/dev';
    const reading = await dependencyHealth.probes.tempDisk();
    expect(reading.state).toMatch(/healthy|degraded|down/);
    expect(reading.metrics.totalBytes).toBeGreaterThan(0);
  });

  it('reads it when there is no local storage directory to compare with', async () => {
    process.env.STORAGE_PATH = '/nonexistent/picpeak-storage-for-test';
    await expect(dependencyHealth.probes.tempDisk()).resolves.toMatchObject({ metrics: expect.any(Object) });
  });
});

describe('diskState', () => {
  it('is relative on a small disk', () => {
    expect(diskState(3 * GIB, 20 * GIB)).toBe('healthy');
    expect(diskState(1.5 * GIB, 20 * GIB)).toBe('degraded');
    expect(diskState(0.4 * GIB, 20 * GIB)).toBe('down');
  });

  it('does not stop a large disk with plenty left', () => {
    expect(diskState(100 * GIB, 2000 * GIB)).toBe('healthy');
    expect(diskState(10 * GIB, 2000 * GIB)).toBe('degraded');
    expect(diskState(3 * GIB, 2000 * GIB)).toBe('down');
  });
});
