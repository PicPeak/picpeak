'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const knex = require('knex');
const { createCoordinator, HEARTBEAT_STALE_MS } = require('../../src/services/portableRestoreCoordinator');
const { createWorkRegistry } = require('../../src/services/activeApplicationWork');
const { leaseProvable } = require('../../src/services/portableRestorePaths');
const { fixtureIngress } = require('./helpers/restoreIngress');

const engines = ['sqlite3', ...(process.env.PICPEAK_PG_TEST_URL ? ['pg'] : [])];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const AVAILABLE = { probe: async () => ({ available: true, reason: null, message: null }) };
const UNAVAILABLE = { probe: async () => ({ available: false, reason: 'RESTORE_UNSUPPORTED_PLATFORM', message: 'Portable restore needs a Linux host' }) };

test('a kernel lease is provable on the same boot, or on the same persisted host after a reboot', () => {
  const boot = crypto.randomUUID();
  const storage = { storageId: crypto.randomUUID(), identity: { host: null, bootId: boot } };
  const row = { storage_id: storage.storageId, boot_id: boot, host_id: null };
  expect(leaseProvable(storage, row)).toBe(true);
  expect(leaseProvable(storage, { ...row, boot_id: crypto.randomUUID() })).toBe(false);
  expect(leaseProvable(storage, { ...row, storage_id: crypto.randomUUID() })).toBe(false);
  storage.identity.host = hash('persisted host id');
  expect(leaseProvable(storage, { ...row, host_id: storage.identity.host, boot_id: crypto.randomUUID() })).toBe(true);
  expect(leaseProvable(storage, { ...row, host_id: hash('another host'), boot_id: crypto.randomUUID() })).toBe(false);
});

describe.each(engines)('portable restore coordinator (%s)', client => {
  let db, directory, schema, storage, instances, native, worker, terminal, starts, recoveries, allGates, ingress, marker, cleaned;
  const row = () => db('portable_restore_control').where({ id: 1 }).first();
  const fence = { read: async () => marker, write: async value => { marker = { ...value, since: Date.now() }; } };
  const cleanup = { attempt: async (attemptId, options) => { cleaned.push({ attemptId, ...options }); }, leftovers: async () => 0 };
  function create({ offline = false, identity = storage, capability = AVAILABLE, ...options } = {}) {
    const work = createWorkRegistry();
    const hooks = { stopServices: jest.fn(async () => {}), resumeServices: jest.fn(async () => {}), forceClose: jest.fn(async () => {}) };
    const coordinator = createCoordinator({ database: db, work, leases: native, worker, ingress, capability, fence, cleanup,
      offline, getStorageIdentity: async () => identity, pollInterval: 5, settleMs: 0, drainGraceMs: 200, forceGraceMs: 50,
      autoPoll: false, ...hooks, ...options });
    const instance = { coordinator, work, ...hooks };
    instances.push(instance);
    return instance;
  }
  // Drive one or more runtimes by hand (autoPoll is off) until the control row
  // reaches the wanted state.
  async function drive(state, ...runtimes) {
    for (let i = 0; i < 400; i++) {
      for (const runtime of runtimes) await runtime.coordinator.tick();
      const current = await row();
      if (current.state === state) return current;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Did not reach ${state}; state is ${(await row()).state}`);
  }
  async function upload() {
    const filename = path.join(directory, `${crypto.randomUUID()}.picpeak`);
    await fs.writeFile(filename, 'owned complete archive fixture', { mode: 0o600 });
    return filename;
  }
  const leaseOf = runtime => [...native.files.values()].find(value => value.path.includes(runtime.coordinator.instanceId()));

  beforeAll(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-coordinator-')));
    schema = `restore_control_${process.pid}_${Date.now()}`;
    db = knex(client === 'pg' ? { client, connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema], pool: { min: 0, max: 4 } }
      : { client, connection: { filename: path.join(directory, 'control.db') }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
    if (client === 'pg') await db.schema.createSchema(schema);
    await require('../../migrations/core/282_portable_restore_control').up(db);
    await require('../../migrations/core/282_portable_restore_control').up(db);
  });
  beforeEach(async () => {
    for (const table of ['portable_restore_commits', 'portable_restore_instances', 'portable_restore_control']) await db(table).delete();
    instances = []; starts = []; recoveries = []; allGates = []; terminal = gate(); allGates.push(terminal);
    marker = null; cleaned = [];
    storage = { root: directory, privateRoot: path.join(directory, '.picpeak-maintenance'), storageId: crypto.randomUUID(),
      device: '1', filesystem: '61353', identity: { bootId: crypto.randomUUID(), host: hash('this host') } };
    await fs.mkdir(path.join(storage.privateRoot, 'runtime'), { recursive: true, mode: 0o700 });
    ({ ingress } = await fixtureIngress(storage.privateRoot));
    const files = new Map();
    native = {
      async acquire(filename) {
        const value = { path: filename, device: '1', inode: String(files.size + 1), filesystem: '61353', state: 'busy' };
        files.set(filename, value);
        return { ...value, release: async () => { value.state = 'free'; } };
      },
      async probe(filename, expected) {
        const value = files.get(filename);
        return value && ['device', 'inode', 'filesystem'].every(key => value[key] === expected[key]) ? value.state : 'unknown';
      }, files,
    };
    const run = async args => {
      // Each run reports through the gate that was current when it was
      // launched. Reading `terminal` after onStart let a run whose pre-exec
      // check was still in flight pick up a gate the test had since swapped in
      // for a later run (on PG the test's own queries do not queue behind it).
      const own = terminal;
      await args.onStart();
      await own.promise;
      if (own.error) throw own.error;
      const result = { attemptId: args.attemptId, proof: 'kernel_lease_released',
        ...(own.result || { outcome: 'committed', summary: { tables: 3, filesRestored: 2, sessionInvalidated: true } }) };
      if (result.outcome === 'committed' && !own.noMarker) {
        const insert = db('portable_restore_commits').insert({ attempt_id: args.attemptId,
          local_plan_checksum: hash('local plan'), options_digest: own.optionsDigest || hash(JSON.stringify(args.options || {})) });
        // A recovery run keeps a marker the import already wrote; an import
        // run writes it exactly once.
        await (args.recovery ? insert.onConflict('attempt_id').ignore() : insert);
      }
      return result;
    };
    worker = {
      async workerLeaseDescriptor({ attemptId }) {
        const parent = path.join(storage.privateRoot, attemptId);
        await fs.mkdir(parent, { mode: 0o700 });
        return { path: path.join(parent, 'worker.lease'), device: '1', inode: '9000', filesystem: '61353' };
      },
      probeWorkerLease: jest.fn(async () => 'free'),
      startWorker: jest.fn(args => { starts.push(args); return run(args); }),
      recoverWorker: jest.fn(args => { recoveries.push(args); return run({ ...args, options: {}, recovery: true }); }),
    };
  });
  afterEach(async () => {
    allGates.forEach(item => item.resolve());
    await Promise.all(instances.map(({ coordinator }) => coordinator.stop()));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  afterAll(async () => {
    if (client === 'pg') await db.schema.dropSchemaIfExists(schema, true);
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  });

  describe('a capability, never a startup requirement', () => {
    it('starts normally where the host cannot run a restore: no registration, no query, a 503 with the reason', async () => {
      const queries = jest.spyOn(db.client, 'query');
      const a = create({ capability: UNAVAILABLE });
      try {
        expect(await a.coordinator.pendingAtBoot()).toBe(false);
        expect(await a.coordinator.activate()).toMatchObject({ available: false, reason: 'RESTORE_UNSUPPORTED_PLATFORM' });
        expect(queries).not.toHaveBeenCalled();
      } finally { queries.mockRestore(); }
      expect(a.coordinator.tracking()).toBe(false);
      expect(() => a.coordinator.admitRequest()).not.toThrow();
      expect(await a.coordinator.capability()).toMatchObject({ available: false, reason: 'RESTORE_UNSUPPORTED_PLATFORM', maintenance: false });
      await expect(a.coordinator.start({ archivePath: await upload(), operatorId: 10 }))
        .rejects.toMatchObject({ statusCode: 503, code: 'RESTORE_UNSUPPORTED_PLATFORM' });
      expect(await db('portable_restore_instances')).toHaveLength(0);
      expect(native.files.size).toBe(0);
    });

    it('does nothing at boot on a capable host that never restored: no row, no lease, no marker, no query', async () => {
      const queries = jest.spyOn(db.client, 'query');
      const a = create();
      try {
        expect(await a.coordinator.pendingAtBoot()).toBe(false);
        expect(await a.coordinator.activate()).toMatchObject({ available: true });
        await a.coordinator.watch();
        await a.coordinator.tick();
        expect(queries).not.toHaveBeenCalled();
      } finally { queries.mockRestore(); }
      expect(await row()).toBeUndefined();
      expect(native.files.size).toBe(0);
      expect(marker).toBeNull();
      expect(a.coordinator.isRegistered()).toBe(false);
      expect(a.coordinator.tracking()).toBe(true);
    });

    it('admits an ordinary request from memory, without a control-row query', async () => {
      const a = create();
      await a.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      const queries = jest.spyOn(db.client, 'query');
      try {
        expect(() => a.coordinator.admitRequest()).toThrow(expect.objectContaining({ statusCode: 503, code: 'RESTORE_MAINTENANCE' }));
        expect(a.coordinator.isFenced()).toBe(true);
        expect(queries).not.toHaveBeenCalled();
      } finally { queries.mockRestore(); }
    });
  });

  describe('a restore that commits', () => {
    it('fences, runs the worker, and requires a restart; the next boot reopens and removes the dead registration', async () => {
      const a = create();
      await a.coordinator.activate();
      const handle = await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      expect(marker).toMatchObject({ fenced: true, generation: 0 });
      expect(handle).toEqual({ attemptId: expect.any(String), progressToken: expect.any(String), state: 'draining' });
      await drive('restoring', a);
      expect(a.stopServices).toHaveBeenCalled();
      terminal.resolve();
      const done = await drive('restart_required', a);
      expect(done.generation).toBe(1);
      expect(cleaned).toContainEqual({ attemptId: handle.attemptId, committed: true });
      await a.coordinator.tick();
      expect(a.coordinator.status()).toMatchObject({ restartRequired: true, maintenance: true });
      expect(a.resumeServices).not.toHaveBeenCalled();
      expect(await a.coordinator.progress(handle.attemptId, handle.progressToken))
        .toMatchObject({ state: 'restart_required', outcome: 'committed', restartRequired: true, error: null, summary: { tables: 3 } });
      const progress = JSON.stringify(await a.coordinator.progress(handle.attemptId, handle.progressToken));
      expect(progress).not.toMatch(/archive_path|worker\.lease|progress_token|options_json|stack/);

      // The process is restarted: its kernel lease is released with it.
      leaseOf(a).state = 'free';
      const b = create();
      expect(await b.coordinator.pendingAtBoot()).toBe(true);
      await b.coordinator.initialize();
      await b.coordinator.waitForStartupAdmission();
      expect((await row()).state).toBe('open');
      expect(marker).toMatchObject({ fenced: false, generation: 1 });
      expect(() => b.coordinator.admitRequest()).not.toThrow();
      expect((await db('portable_restore_instances')).map(item => item.instance_id)).toEqual([b.coordinator.instanceId()]);
    });

    it('refuses a commit report that has no matching database marker', async () => {
      const a = create();
      await a.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      // The worker reports a commit but never wrote the marker.
      terminal.noMarker = true;
      terminal.resolve();
      const current = await drive('recovery_required', a);
      expect(await db('portable_restore_commits')).toHaveLength(0);
      expect(current.generation).toBe(0);
      expect(JSON.parse(current.result_json)).toMatchObject({ outcome: 'recovery_required',
        error: { message: 'Matching restore commit marker is unavailable' } });
      expect(a.coordinator.isFenced()).toBe(true);
    });

    it('refuses a commit whose marker was written for different restore options', async () => {
      const a = create();
      await a.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      // A well-formed marker for this attempt, but its digest is not the one
      // of the options this control row fenced.
      terminal.optionsDigest = hash(JSON.stringify({ migrationStorageIndexPath: '/elsewhere' }));
      terminal.resolve();
      const current = await drive('recovery_required', a);
      expect(await db('portable_restore_commits')).toHaveLength(1);
      expect(current.generation).toBe(0);
      expect(JSON.parse(current.result_json)).toMatchObject({ outcome: 'recovery_required',
        error: { message: 'Matching restore commit marker is unavailable' } });
      expect(a.coordinator.isFenced()).toBe(true);
    });
  });

  describe('a restore that fails reopens the instance', () => {
    it('reopens automatically after a verified rollback and reports the reason', async () => {
      const a = create();
      await a.coordinator.activate();
      const handle = await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      terminal.result = { outcome: 'rolled_back', summary: {},
        error: { code: 'RESTORE_TABLE_CHECKSUM', statusCode: 400, message: 'The backup\'s "photos" table does not match its recorded checksum' } };
      terminal.resolve();
      const current = await drive('open', a);
      expect(current.generation).toBe(0);
      await a.coordinator.tick();
      expect(() => a.coordinator.admitRequest()).not.toThrow();
      expect(a.coordinator.status()).toMatchObject({ maintenance: false, restartRequired: false });
      expect(a.resumeServices).toHaveBeenCalledTimes(1);
      expect(marker).toMatchObject({ fenced: false, generation: 0 });
      expect(cleaned).toContainEqual({ attemptId: handle.attemptId, committed: false });
      expect(await a.coordinator.progress(handle.attemptId, handle.progressToken)).toMatchObject({
        state: 'open', outcome: 'rolled_back', complete: true, restartRequired: false,
        error: { code: 'RESTORE_TABLE_CHECKSUM', message: expect.stringContaining('photos') } });
      // A second restore on the same runtime is possible straight away.
      terminal = gate(); allGates.push(terminal);
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
    });

    const crmPolicy = require('fs').existsSync(require('path').resolve(__dirname, '../../src/database/crmAccess.js'))
      ? require('../../src/database/crmAccess') : null;
    (crmPolicy ? it : it.skip)('runs the worker launch and the restart of services as trusted maintenance, not under the uploading admin', async () => {
      let depth = 0;
      const entered = [];
      const trustedAccess = jest.spyOn(crmPolicy, 'withTrustedCrmAccess').mockImplementation(async (reason, run) => {
        depth += 1;
        try { return await run(); } finally { depth -= 1; }
      });
      try {
        const a = create();
        a.resumeServices.mockImplementation(async () => { entered.push(['resume', depth]); });
        worker.startWorker.mockImplementationOnce(async args => { entered.push(['worker', depth]); await args.onStart(); throw new Error('worker failed'); });
        terminal.result = { outcome: 'rolled_back', summary: {} };
        terminal.resolve();
        await a.coordinator.activate();
        // The reservation comes from an admin's request, which carries no trusted access.
        await crmPolicy.withoutCrmContext(() => a.coordinator.start({ archivePath: require('path').join(directory, 'x') }).catch(() => {}));
        await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
        await drive('open', a);
        await a.coordinator.tick();
        expect(entered).toEqual([['worker', 1], ['resume', 1]]);
        expect(trustedAccess).toHaveBeenCalledWith('coordinated portable restore', expect.any(Function));
      } finally { trustedAccess.mockRestore(); }
    });

    it('a crashed worker is recovered once and the instance reopens when recovery rolls back', async () => {
      const a = create();
      await a.coordinator.activate();
      const handle = await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      worker.startWorker.mockImplementationOnce(async args => {
        await args.onStart();
        throw Object.assign(new Error('worker ran out of its time budget'), { code: 'PICPEAK_IMPORT_TIMEOUT' });
      });
      terminal.result = { outcome: 'rolled_back', summary: {} };
      terminal.resolve();
      await drive('open', a);
      expect(recoveries).toHaveLength(1);
      await a.coordinator.tick();
      expect(a.resumeServices).toHaveBeenCalledTimes(1);
      expect(await a.coordinator.progress(handle.attemptId, handle.progressToken))
        .toMatchObject({ outcome: 'rolled_back', error: { code: 'RESTORE_ROLLED_BACK' } });
    });
  });

  describe('the drain has a deadline', () => {
    it('closes connections after the grace period and continues once the work ends', async () => {
      const stuck = gate(); allGates.push(stuck);
      const a = create({ drainGraceMs: 30, forceGraceMs: 500 });
      a.forceClose.mockImplementation(async () => { stuck.resolve(); });
      await a.coordinator.activate();
      void a.work.track('long-lived download', () => stuck.promise);
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      expect(a.forceClose).toHaveBeenCalledTimes(1);
    });

    it('aborts the restore and reopens when work never ends', async () => {
      const stuck = gate(); allGates.push(stuck);
      const a = create({ drainGraceMs: 30, forceGraceMs: 30 });
      await a.coordinator.activate();
      void a.work.track('handler that never returns', () => stuck.promise);
      const handle = await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('open', a);
      await a.coordinator.tick();
      expect(a.forceClose).toHaveBeenCalledTimes(1);
      expect(starts).toHaveLength(0);
      expect(() => a.coordinator.admitRequest()).not.toThrow();
      expect(a.resumeServices).toHaveBeenCalledTimes(1);
      expect(await a.coordinator.progress(handle.attemptId, handle.progressToken))
        .toMatchObject({ state: 'open', outcome: 'aborted', error: { code: 'RESTORE_DRAIN_TIMEOUT' } });
    });
  });

  describe('a crash or reboot never fences forever', () => {
    const foreign = (overrides = {}) => ({ instance_id: crypto.randomUUID(), generation: 0, storage_id: storage.storageId,
      host_id: null, boot_id: crypto.randomUUID(), lease_json: JSON.stringify({ path: path.join(storage.privateRoot, 'runtime', 'gone.lease'), device: '1', inode: '77', filesystem: '61353' }),
      heartbeat_at: new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString(), ...overrides });

    it('treats a registration from another boot whose heartbeat stopped as dead and deletes it', async () => {
      const a = create();
      await a.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      const dead = foreign();
      await db('portable_restore_instances').insert(dead);
      await drive('restoring', a);
      terminal.result = { outcome: 'rolled_back', summary: {} };
      terminal.resolve();
      await drive('open', a);
      const b = create();
      await b.coordinator.activate();
      await b.coordinator.start({ archivePath: await upload(), operatorId: 10 }).catch(() => {});
      expect(await db('portable_restore_instances').where({ instance_id: dead.instance_id })).toHaveLength(0);
    });

    it('waits for a registration that is still heartbeating, then gives up and reopens', async () => {
      const a = create({ drainGraceMs: 20, forceGraceMs: 20 });
      await a.coordinator.activate();
      // Registered before the restore starts: start() launches its own tick,
      // and with settleMs 0 that tick can find the cohort quiescent and admit
      // the worker before a row inserted afterwards exists. The row then fails
      // the worker's pre-exec check and the run ends in recovery_required.
      await db('portable_restore_instances').insert(foreign({ heartbeat_at: new Date().toISOString() }));
      const handle = await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('open', a);
      expect(starts).toHaveLength(0);
      expect(await a.coordinator.progress(handle.attemptId, handle.progressToken))
        .toMatchObject({ outcome: 'aborted', error: { code: 'RESTORE_DRAIN_TIMEOUT' } });
    });

    it('a new process takes over a restore whose owner died with the host and reopens after rolling it back', async () => {
      const a = create();
      await a.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      // The host reboots mid-restore: new boot id, the owner's lease is gone
      // with it, its heartbeat is old, and the worker never reported.
      await a.coordinator.stop();
      native.files.clear();
      await db('portable_restore_instances').update({ heartbeat_at: new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString() });
      const rebooted = { ...storage, identity: { bootId: crypto.randomUUID(), host: null } };
      // The dead owner's worker never reports. Only the recovery the new
      // process starts gets a result; resolving the owner's own gate let the
      // stopped owner finish the rollback first, now and then.
      terminal = gate(); allGates.push(terminal);
      terminal.result = { outcome: 'rolled_back', summary: {} };
      terminal.resolve();
      const b = create({ identity: rebooted });
      expect(await b.coordinator.pendingAtBoot()).toBe(true);
      await b.coordinator.initialize();
      await b.coordinator.waitForStartupAdmission();
      expect(recoveries).toHaveLength(1);
      expect((await row()).state).toBe('open');
      expect(() => b.coordinator.admitRequest()).not.toThrow();
      expect((await db('portable_restore_instances')).map(item => item.instance_id)).toEqual([b.coordinator.instanceId()]);
    });

    it('a stale marker without a fenced control row is not a pending restore', async () => {
      const a = create();
      await a.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      terminal.result = { outcome: 'rolled_back', summary: {} };
      terminal.resolve();
      await drive('open', a);
      marker = { fenced: true, generation: 0, since: 0 };
      const b = create();
      expect(await b.coordinator.pendingAtBoot()).toBe(false);
    });

    it('follows a replaced storage volume while no restore is running', async () => {
      const a = create();
      await a.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      terminal.result = { outcome: 'rolled_back', summary: {} };
      terminal.resolve();
      await drive('open', a);
      leaseOf(a).state = 'free';
      await db('portable_restore_instances').update({ heartbeat_at: new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString() });
      const moved = { ...storage, storageId: crypto.randomUUID() };
      const b = create({ identity: moved });
      await b.coordinator.activate();
      terminal = gate(); allGates.push(terminal);
      await b.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      expect((await row()).storage_id).toBe(moved.storageId);
    });
  });

  describe('other runtimes join through the fence marker', () => {
    it('a runtime that never registered notices the marker, drains and acknowledges before the worker starts', async () => {
      const a = create();
      const b = create();
      await a.coordinator.activate();
      await b.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      expect(b.coordinator.isRegistered()).toBe(false);
      await b.coordinator.watch();
      expect(b.coordinator.isRegistered()).toBe(true);
      expect(b.stopServices).toHaveBeenCalled();
      expect(() => b.coordinator.admitRequest()).toThrow(expect.objectContaining({ statusCode: 503 }));
      await drive('restoring', a, b);
      expect((await db('portable_restore_instances')).every(item => item.ack_epoch === (starts[0].epoch))).toBe(true);
      terminal.result = { outcome: 'rolled_back', summary: {} };
      terminal.resolve();
      await drive('open', a, b);
      await b.coordinator.tick();
      expect(b.resumeServices).toHaveBeenCalledTimes(1);
      expect(() => b.coordinator.admitRequest()).not.toThrow();
    });

    it('a runtime that only notices after the commit must restart and stays closed', async () => {
      const a = create();
      const b = create();
      await a.coordinator.activate();
      await b.coordinator.activate();
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await drive('restoring', a);
      terminal.resolve();
      await drive('restart_required', a);
      await b.coordinator.watch();
      expect(b.coordinator.status()).toMatchObject({ restartRequired: true });
      expect(() => b.coordinator.admitRequest()).toThrow(expect.objectContaining({ statusCode: 503 }));
      marker = { fenced: false, generation: 1, since: Date.now() };
      const c = create();
      await c.coordinator.activate();
      marker = { fenced: false, generation: 2, since: Date.now() };
      await c.coordinator.watch();
      expect(c.coordinator.status()).toMatchObject({ restartRequired: true });
    });
  });

  describe('offline restore', () => {
    it('restores with no other runtime and reports the committed summary', async () => {
      const offline = create({ offline: true, stopServices: undefined });
      terminal.resolve();
      await expect(offline.coordinator.restoreOffline({ archivePath: await upload() }))
        .resolves.toMatchObject({ restored: true, outcome: 'committed', restartRequired: true, tables: 3 });
      expect((await row()).state).toBe('restart_required');
    });

    it('runs again after a restore that committed: with the old runtime gone it reopens the fence itself', async () => {
      const first = create({ offline: true });
      terminal.resolve();
      await first.coordinator.restoreOffline({ archivePath: await upload() });
      expect((await row()).state).toBe('restart_required');
      const second = create({ offline: true });
      await expect(second.coordinator.restoreOffline({ archivePath: await upload() })).resolves.toMatchObject({ outcome: 'committed' });
      expect(starts).toHaveLength(2);
      expect((await row()).generation).toBe(2);
    });

    it('refuses while a server runtime is alive, and leaves that server open', async () => {
      const server = create();
      await server.coordinator.activate();
      // The settle window is what lets a running server notice the marker.
      // The offline tool's clock stands still until the server has joined:
      // on wall time a loaded runner could spend the whole window before the
      // server's watch got through, and the offline tool would then rightly
      // see nobody else and restore.
      let clock = Date.now();
      const offline = create({ offline: true, settleMs: 1500, now: () => clock });
      const attempt = offline.coordinator.restoreOffline({ archivePath: await upload() });
      attempt.catch(() => {});
      const deadline = Date.now() + 15000;
      while (!marker?.fenced && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      // The first watch can find the reservation still holding the ingress
      // slot; the next one joins, as the interval does in a running server.
      while (!server.coordinator.isRegistered() && Date.now() < deadline) {
        await server.coordinator.watch();
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(server.coordinator.isRegistered()).toBe(true);
      clock += 1500;
      await server.coordinator.tick();
      await expect(attempt).rejects.toMatchObject({ code: 'RESTORE_DRAIN_TIMEOUT' });
      expect(starts).toHaveLength(0);
      await server.coordinator.tick();
      expect((await row()).state).toBe('open');
      expect(() => server.coordinator.admitRequest()).not.toThrow();
    });

    it('explains itself where the host cannot run a coordinated restore', async () => {
      const offline = create({ offline: true, capability: UNAVAILABLE });
      await expect(offline.coordinator.restoreOffline({ archivePath: await upload() }))
        .rejects.toMatchObject({ code: 'RESTORE_UNSUPPORTED_PLATFORM', statusCode: 503 });
    });
  });
});
