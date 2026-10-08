'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const knex = require('knex');
const { createCoordinator } = require('../../src/services/portableRestoreCoordinator');
const { createWorkRegistry } = require('../../src/services/activeApplicationWork');
const { sameRuntimeVolume } = require('../../src/services/portableRestorePaths');
const { fixtureIngress } = require('./helpers/restoreIngress');

const engines = ['sqlite3', ...(process.env.PICPEAK_PG_TEST_URL ? ['pg'] : [])];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test.each(['test', 'production'])('NODE_ENV=%s never supplies unstarted server authority alone', environment => {
  require('child_process').execFileSync(process.execPath, ['-e', `
    const policy = require('./src/services/portableRestoreCoordinator');
    policy.admitRequest().then(() => { process.exitCode = 1; }, error => {
      if (error.code !== 'RESTORE_MAINTENANCE') throw error;
      if (process.env.NODE_ENV === 'production') {
        try { policy.enterUnstartedServerFixtureContext(); process.exitCode = 1; }
        catch (error) { if (!error.message.includes('test-only')) throw error; }
      }
    });
  `], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, NODE_ENV: environment }, timeout: 10000 });
});

test('same-kernel proof works without container machine-id; changed boot requires authoritative same host', () => {
  const boot = crypto.randomUUID();
  const storage = { storageId: crypto.randomUUID(), identity: { host: null, bootId: boot } };
  const row = { storage_id: storage.storageId, boot_id: boot, host_id: null };
  expect(sameRuntimeVolume(storage, row)).toBe(true);
  expect(sameRuntimeVolume(storage, { ...row, boot_id: crypto.randomUUID() })).toBe(false);
  expect(sameRuntimeVolume(storage, { ...row, storage_id: crypto.randomUUID() })).toBe(false);
  storage.identity.host = hash('same-authoritative-host');
  expect(sameRuntimeVolume(storage, { ...row, host_id: hash('foreign-host') })).toBe(false);
  expect(sameRuntimeVolume(storage, { ...row, host_id: storage.identity.host, boot_id: crypto.randomUUID() })).toBe(true);
});

describe.each(engines)('durable portable coordinator (%s)', client => {
  let db, directory, schema, storage, instances, native, worker, terminal, starts, recoveries, allGates, ingress;
  const row = () => db('portable_restore_control').where({ id: 1 }).first();
  const waitState = async state => {
    for (let i = 0; i < 150; i++) {
      const current = await row();
      if (current.state === state) return current;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Did not reach ${state}`);
  };
  async function create({ offline = false, identity = storage, stopServices = async () => {}, ready = true } = {}) {
    const work = createWorkRegistry();
    const coordinator = createCoordinator({ database: db, work, leases: native, worker, ingress, stopServices,
      offline, getStorageIdentity: async () => identity, pollInterval: 10, autoPoll: false });
    instances.push({ coordinator, work });
    await coordinator.initialize();
    if (!offline && (await row()).state === 'open') {
      await coordinator.waitForStartupAdmission(); if (ready) coordinator.markReady();
    }
    return { coordinator, work };
  }
  async function upload() {
    const filename = path.join(directory, `${crypto.randomUUID()}.picpeak`);
    await fs.writeFile(filename, 'owned complete archive fixture', { mode: 0o600 });
    return filename;
  }
  function failOneControlRead() {
    const query = db.client.query;
    let failNext = true;
    return jest.spyOn(db.client, 'query').mockImplementation(function (...args) {
      if (failNext && /select .*portable_restore_control/i.test(args[1]?.sql || '')) {
        failNext = false; return Promise.reject(new Error('owned transient replacement fixture'));
      }
      return query.apply(this, args);
    });
  }

  beforeAll(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-coordinator-')));
    schema = `restore_control_${process.pid}_${Date.now()}`;
    db = knex(client === 'pg' ? { client, connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema], pool: { min: 0, max: 4 } }
      : { client, connection: { filename: path.join(directory, 'control.db') }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
    if (client === 'pg') await db.schema.createSchema(schema);
    await require('../../migrations/core/271_portable_restore_control').up(db);
    await require('../../migrations/core/271_portable_restore_control').up(db);
  });
  beforeEach(async () => {
    for (const table of ['portable_restore_commits', 'portable_restore_instances', 'portable_restore_control']) await db(table).delete();
    instances = []; starts = []; recoveries = []; allGates = []; terminal = gate(); allGates.push(terminal);
    storage = { root: directory, privateRoot: path.join(directory, '.picpeak-maintenance'), storageId: crypto.randomUUID(),
      device: '1', filesystem: '61353', identity: { bootId: crypto.randomUUID(), host: null } };
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
      await args.onStart();
      await terminal.promise;
      const result = terminal.result || { outcome: 'committed', attemptId: args.attemptId, proof: 'kernel_lease_released',
        summary: { tables: 3, filesRestored: 2, sessionInvalidated: true } };
      if (result.outcome === 'committed') await db('portable_restore_commits').insert({ attempt_id: args.attemptId,
        local_plan_checksum: hash('local plan'), options_digest: hash(JSON.stringify(args.options || {})) });
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
      recoverWorker: jest.fn(args => { recoveries.push(args); return run(args); }),
    };
  });
  afterEach(async () => {
    allGates.forEach(item => item.resolve());
    await Promise.all(instances.map(({ coordinator }) => coordinator.stop()));
    // Wait only fixture-owned finite continuations before the next DB reset.
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  afterAll(async () => {
    if (client === 'pg') await db.schema.dropSchemaIfExists(schema, true);
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('fresh durable ingress does not inherit the existing cached-maintenance/admin-header exemptions', async () => {
    const a = await create();
    await a.coordinator.admitRequest();
    const handle = await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await expect(a.coordinator.admitRequest({ headers: { authorization: 'Bearer fake' } })).rejects.toMatchObject({ statusCode: 503 });
    expect(await a.coordinator.progress(handle.attemptId, handle.progressToken)).toMatchObject({ state: expect.any(String) });
    await expect(a.coordinator.progress(handle.attemptId, 'a'.repeat(64))).rejects.toMatchObject({ statusCode: 404 });
    const progress = JSON.stringify(await a.coordinator.progress(handle.attemptId, handle.progressToken));
    expect(progress).not.toMatch(/archive_path|worker\.lease|progress_token|options_json|stack/);
    terminal.resolve(); await waitState('restart_required');
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('a solely transient control read pause resumes an undrained native-style runtime after positive proof', async () => {
    const a = await create();
    const fault = failOneControlRead();
    try {
      await a.work.track('accepted native-style restore body', () => ingress.withIngress(async () => {
        await a.coordinator.tick();
        expect(a.work.isClosed()).toBe(true);
        await a.coordinator.tick();
        await expect(a.coordinator.admitRequest()).resolves.toBeUndefined();
      }));
    } finally { fault.mockRestore(); }
  });

  it('terminal native revalidation restores readiness but startup revalidation never makes a cold runtime ready', async () => {
    for (const ready of [false, true]) {
      const a = await create({ ready });
      const fault = failOneControlRead();
      try {
        await a.work.track('accepted terminal native body', () => ingress.withIngress(async () => {
          await a.coordinator.tick(); expect(a.work.isClosed()).toBe(true);
          await a.coordinator.revalidateAfterNativeRestore(); expect(a.work.isClosed()).toBe(false);
          if (ready) await a.coordinator.admitUpload();
          else {
            await expect(a.coordinator.admitUpload()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
            await a.coordinator.admitStartupRestore();
          }
        }));
      } finally { fault.mockRestore(); }
      if (!ready) { a.coordinator.markReady(); await a.coordinator.admitRequest(); }
    }
  });

  it.each(['missing registration', 'changed tuple', 'unknown lease', 'free lease', 'replaced inode', 'unshared marker',
    'changed canonical root', 'changed generation', 'changed control volume'])('a read pause remains closed with %s', async changed => {
    const a = await create(); const fault = failOneControlRead();
    try { await a.coordinator.tick(); } finally { fault.mockRestore(); }
    const own = db('portable_restore_instances').where({ instance_id: a.coordinator.instanceId() });
    const lease = [...native.files.values()].find(value => value.path.includes(a.coordinator.instanceId()));
    if (changed === 'missing registration') await own.delete();
    if (changed === 'changed tuple') await own.update({ boot_id: crypto.randomUUID() });
    if (changed === 'unknown lease') lease.state = 'unknown';
    if (changed === 'free lease') lease.state = 'free';
    if (changed === 'replaced inode') lease.inode = 'replacement';
    if (changed === 'unshared marker') storage.storageId = crypto.randomUUID();
    if (changed === 'changed canonical root') storage.root = `${directory}/foreign`;
    if (changed === 'changed generation') await db('portable_restore_control').where({ id: 1 }).increment('generation', 1);
    if (changed === 'changed control volume') await db('portable_restore_control').where({ id: 1 }).update({ storage_id: crypto.randomUUID() });
    await a.coordinator.tick();
    expect(a.work.isClosed()).toBe(true);
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    expect(starts).toHaveLength(0);
  });

  it('a changed durable OPEN revision during proof cannot resume until a new unchanged proof', async () => {
    const a = await create(); const fault = failOneControlRead();
    try { await a.coordinator.tick(); } finally { fault.mockRestore(); }
    const probe = native.probe; let change = true;
    native.probe = async (...args) => {
      if (change) { change = false; await db('portable_restore_control').where({ id: 1 }).increment('revision', 1); }
      return probe(...args);
    };
    await a.coordinator.tick(); expect(a.work.isClosed()).toBe(true);
    await a.coordinator.tick(); await a.coordinator.admitRequest();
  });

  it('a stopped paused process, no-scope caller or control request cannot revalidate native readiness', async () => {
    const a = await create(); const fault = failOneControlRead();
    try { await a.coordinator.tick(); } finally { fault.mockRestore(); }
    await expect(a.coordinator.revalidateAfterNativeRestore()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await expect(a.work.runControl(() => a.coordinator.revalidateAfterNativeRestore())).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await a.coordinator.stop(); await a.coordinator.tick();
    expect(a.work.isClosed()).toBe(true);
  });

  it('terminal runtime-proof errors close a healthy owner without granting startup or read-pause reopening', async () => {
    const a = await create(); const probe = native.probe;
    await a.work.track('accepted native terminal body', () => ingress.withIngress(async () => {
      native.probe = async () => { throw new Error('owned unavailable kernel fixture'); };
      await expect(a.coordinator.revalidateAfterNativeRestore()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
      native.probe = probe;
      expect(a.work.isClosed()).toBe(true);
      await expect(a.coordinator.revalidateAfterNativeRestore()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    }));
    const fault = failOneControlRead();
    try { await a.coordinator.tick(); } finally { fault.mockRestore(); }
    await a.coordinator.tick(); expect(a.work.isClosed()).toBe(true);
    await expect(a.coordinator.waitForStartupAdmission()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
  });

  it('stopped native owners cannot revalidate from their still-active ordinary scope', async () => {
    const a = await create();
    await a.work.track('accepted native stopping body', () => ingress.withIngress(async () => {
      const fault = failOneControlRead();
      try { await a.coordinator.tick(); } finally { fault.mockRestore(); }
      await a.coordinator.stop();
      await expect(a.coordinator.revalidateAfterNativeRestore()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
      expect(a.work.isClosed()).toBe(true);
    }));
  });

  it('an observed drain stays sticky even if durable control is reset to the old OPEN generation', async () => {
    const a = await create(); const held = gate(); allGates.push(held);
    const body = a.work.track('accepted old native body', async () => {
      await held.promise;
      await expect(a.coordinator.revalidateAfterNativeRestore()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    });
    const original = await row();
    await db('portable_restore_control').where({ id: 1 }).update({ state: 'draining', epoch: crypto.randomUUID(),
      attempt_id: crypto.randomUUID(), owner_instance_id: crypto.randomUUID() });
    const draining = a.coordinator.tick();
    await new Promise(done => setTimeout(done, 10));
    expect(a.work.isClosed()).toBe(true);
    held.resolve(); await Promise.all([body, draining]);
    await db('portable_restore_control').where({ id: 1 }).update({ ...original });
    await a.coordinator.tick(); expect(a.work.isClosed()).toBe(true);
    await expect(a.coordinator.waitForStartupAdmission()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
  });

  it('cold pre-start quiescence clears only at its proven barrier and the next epoch stops newly started writers', async () => {
    const a = await create(); await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    terminal.resolve(); await waitState('restart_required');
    const stopped = [];
    const cold = await create({ ready: false, stopServices: async () => { stopped.push('stop'); } });
    expect(stopped).toHaveLength(2);
    for (const value of native.files.values()) if (value.path.includes(a.coordinator.instanceId())) value.state = 'free';
    await cold.coordinator.tick(); await cold.coordinator.waitForStartupAdmission(); cold.coordinator.markReady();
    const held = gate(); allGates.push(held);
    const writer = cold.work.track('newly started cold runtime writer', () => held.promise);
    await cold.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await new Promise(done => setTimeout(done, 10));
    expect(stopped).toHaveLength(3);
    expect((await db('portable_restore_instances').where({ instance_id: cold.coordinator.instanceId() }).first()).ack_epoch).not.toBe((await row()).epoch);
    held.resolve(); await writer; await cold.coordinator.tick();
    expect(stopped).toHaveLength(4);
    await waitState('restart_required');
  });

  it('waits for every live replica to close and drain before its explicit ACK and worker admission', async () => {
    const a = await create(); const b = await create();
    const held = gate(); allGates.push(held);
    const pending = b.work.track('accepted detached writer', () => held.promise);
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await a.coordinator.tick();
    expect(starts).toHaveLength(0);
    await db('portable_restore_instances').where({ instance_id: b.coordinator.instanceId() }).update({ registered_at: '1900-01-01' });
    const pause = b.coordinator.tick();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await db('portable_restore_instances').where({ instance_id: b.coordinator.instanceId() }).first()).ack_epoch).toBeNull();
    expect(starts).toHaveLength(0);
    held.resolve(); await Promise.all([pending, pause]);
    await a.coordinator.tick();
    expect(starts).toHaveLength(1);
    expect(starts[0].epoch).toBe((await row()).epoch);
    terminal.resolve(); await waitState('restart_required');
  });

  it('stops resources constructed by an already admitted startup after its first shutdown snapshot', async () => {
    let constructed = false;
    const stopped = [];
    const a = await create({ stopServices: async () => { stopped.push(constructed); } });
    const held = gate(); allGates.push(held);
    const startup = a.work.track('admitted runtime startup', async () => { await held.promise; constructed = true; });
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stopped).toEqual([false]);
    held.resolve(); await startup; await a.coordinator.tick();
    expect(stopped).toEqual([false, true]);
    expect(starts).toHaveLength(1);
    terminal.resolve(); await waitState('restart_required');
  });

  it('failed start invokes supervised recovery rather than inferring rollback from an absent marker', async () => {
    const a = await create();
    worker.startWorker.mockRejectedValue(Object.assign(new Error('worker exited before proof'), { code: 'RESTORE_WORKER_FAILED' }));
    worker.recoverWorker.mockImplementation(async args => {
      await args.onStart();
      return { attemptId: args.attemptId, proof: 'kernel_lease_released', outcome: 'rolled_back' };
    });
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await waitState('recovery_required');
    await a.coordinator.tick();
    await waitState('restart_required');
    expect(worker.recoverWorker).toHaveBeenCalledTimes(1);
    expect(await db('portable_restore_commits').count('* as count').first()).toMatchObject({ count: client === 'pg' ? '0' : 0 });
    expect((await row()).result_json).toContain('rolled_back');
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('successful terminal proof remains fenced until all old lifetimes are free and new runtimes ACK', async () => {
    const a = await create(); const b = await create();
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await b.coordinator.tick(); await a.coordinator.tick();
    terminal.resolve(); const verified = await waitState('restart_required');
    const c = await create();
    expect((await row()).state).toBe('restart_required');
    expect(c.work.isClosed()).toBe(true);
    for (const value of native.files.values()) if (!value.path.includes(c.coordinator.instanceId())) value.state = 'free';
    await c.coordinator.tick();
    expect((await row()).state).toBe('open');
    expect((await row()).generation).toBe(verified.generation);
    await c.coordinator.waitForStartupAdmission(); c.coordinator.markReady();
    await c.coordinator.admitRequest();
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('serializes cold registration against the proof cohort and opening transaction', async () => {
    const a = await create();
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    terminal.resolve(); await waitState('restart_required');
    const c = await create();
    const owner = [...native.files.values()].find(value => value.path.includes(a.coordinator.instanceId()));
    owner.state = 'free';
    const proof = gate(); const entered = gate(); allGates.push(proof, entered);
    const original = native.probe;
    let intercepted = false;
    native.probe = async (...args) => {
      if (!intercepted && args[0] === owner.path) {
        intercepted = true; entered.resolve(); await proof.promise;
      }
      return original(...args);
    };
    const opening = c.coordinator.tick(); await entered.promise;
    let registered = false;
    const registering = create().then(value => { registered = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(registered).toBe(false);
    proof.resolve(); await opening;
    const d = await registering;
    expect((await row()).state).toBe('open');
    await d.coordinator.admitRequest();
  });

  it('checks every permanently registered lifetime with finite keyset pages, never a time-based cohort cutoff', async () => {
    const a = await create();
    const rows = Array.from({ length: 205 }, (_, index) => {
      const id = crypto.randomUUID();
      const lease = { path: path.join(storage.privateRoot, 'runtime', `${id}.lease`), device: '1', inode: String(2000 + index), filesystem: '61353', state: 'free' };
      native.files.set(lease.path, lease);
      return { instance_id: id, generation: 0, storage_id: storage.storageId, boot_id: storage.identity.bootId,
        lease_json: JSON.stringify({ path: lease.path, device: lease.device, inode: lease.inode, filesystem: lease.filesystem }) };
    });
    await db.batchInsert('portable_restore_instances', rows, 50);
    const queries = [];
    const observe = query => { if (/select .*portable_restore_instances/i.test(query.sql)) queries.push(query); };
    db.on('query', observe);
    try {
      await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      terminal.resolve(); await waitState('restart_required');
      const owner = [...native.files.values()].find(value => value.path.includes(a.coordinator.instanceId())); owner.state = 'free';
      const c = await create(); await c.coordinator.waitForStartupAdmission(); c.coordinator.markReady();
      await c.coordinator.admitRequest();
      const pages = queries.filter(query => /order by .*instance_id/i.test(query.sql));
      expect(pages.length).toBeGreaterThanOrEqual(6);
      expect(pages.every(query => query.bindings.includes(100) && !/offset/i.test(query.sql))).toBe(true);
      const pointProofs = queries.filter(query => !pages.includes(query));
      expect(pointProofs.every(query => /where .*instance_id.*=/.test(query.sql)
        && /limit/i.test(query.sql) && query.bindings.includes(1) && !/offset/i.test(query.sql))).toBe(true);
    } finally { db.removeListener('query', observe); }
  });

  it.each(['busy', 'unknown'])('never treats owner or worker %s proof as timeout death', async proof => {
    const a = await create();
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await a.coordinator.tick();
    const c = await create();
    const ownerLease = [...native.files.values()].find(value => value.path.includes(a.coordinator.instanceId()));
    ownerLease.state = proof;
    await c.coordinator.tick(); expect(recoveries).toHaveLength(0);
    ownerLease.state = 'free'; worker.probeWorkerLease.mockResolvedValue(proof);
    await c.coordinator.tick(); expect(recoveries).toHaveLength(0);
    expect((await row()).state).not.toBe('open');
    terminal.resolve();
  });

  it('wrong terminal attempt/proof or absent commit marker cannot reopen', async () => {
    const a = await create();
    terminal.result = { outcome: 'committed', attemptId: crypto.randomUUID(), proof: 'kernel_lease_released' };
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    terminal.resolve(); await waitState('recovery_required');
    expect((await row()).generation).toBe(0);
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('requires the matching commit marker and digest even when the terminal worker says committed', async () => {
    const a = await create();
    worker.startWorker.mockImplementation(async args => {
      await args.onStart();
      return { outcome: 'committed', attemptId: args.attemptId, proof: 'kernel_lease_released' };
    });
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await waitState('recovery_required');
    expect((await row()).generation).toBe(0);
    await expect(a.coordinator.admitRequest()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('a replaced inode or unshared volume stays fenced even if a copied lease appears free', async () => {
    const a = await create();
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    terminal.resolve(); await waitState('restart_required');
    const lease = [...native.files.values()].find(value => value.path.includes(a.coordinator.instanceId()));
    lease.state = 'free'; lease.inode = 'replaced';
    const c = await create(); await c.coordinator.tick();
    expect((await row()).state).toBe('restart_required');
    await expect(create({ identity: { ...storage, storageId: crypto.randomUUID() } })).rejects.toMatchObject({ code: 'RESTORE_STORAGE_MISMATCH' });
  });

  it('a live offline peer ACK is not death proof; no worker is launched', async () => {
    const a = await create(); const offline = await create({ offline: true });
    await expect(offline.coordinator.restoreOffline({ archivePath: await upload(), operatorId: 10 }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(starts).toHaveLength(0);
    expect((await row()).state).toBe('open');
    await a.coordinator.admitRequest();
  });

  it.each(['unshared volume', 'different host', 'replaced busy inode'])('a live %s ACK cannot admit a restore worker', async kind => {
    const a = await create(); const b = await create();
    const query = db('portable_restore_instances').where({ instance_id: b.coordinator.instanceId() });
    if (kind === 'unshared volume') await query.update({ storage_id: crypto.randomUUID() });
    if (kind === 'different host') {
      storage.identity.host = hash('authoritative host');
      await query.update({ host_id: hash('another host') });
    }
    if (kind === 'replaced busy inode') {
      const lease = [...native.files.values()].find(value => value.path.includes(b.coordinator.instanceId())); lease.inode = 'replacement';
    }
    await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    await b.coordinator.tick(); await a.coordinator.tick();
    expect((await db('portable_restore_instances').where({ instance_id: b.coordinator.instanceId() }).first()).ack_epoch).toBe((await row()).epoch);
    expect(starts).toHaveLength(0);
    expect((await row()).state).toBe('draining');
  });

  it('a cold runtime on an unshared volume cannot open the restart barrier with startup-ready ACK', async () => {
    const a = await create(); await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
    terminal.resolve(); await waitState('restart_required');
    const c = await create();
    await db('portable_restore_instances').where({ instance_id: c.coordinator.instanceId() }).update({ storage_id: crypto.randomUUID() });
    for (const value of native.files.values()) if (value.path.includes(a.coordinator.instanceId())) value.state = 'free';
    await c.coordinator.tick();
    const ready = await db('portable_restore_instances').where({ instance_id: c.coordinator.instanceId() }).first();
    expect(ready.startup_ready_epoch).toBe((await row()).epoch);
    expect((await row()).state).toBe('restart_required');
  });

  it.each(['missing archive', 'oversize archive', 'invalid options'])('offline %s preclaim failure positively releases its private runtime', async kind => {
    const offline = await create({ offline: true });
    const archivePath = kind === 'missing archive' ? path.join(directory, 'nonexistent.picpeak') : await upload();
    if (kind === 'oversize archive') await fs.truncate(archivePath, 5 * 1024 ** 3 + 1);
    await expect(offline.coordinator.restoreOffline({ archivePath, operatorId: 10,
      options: kind === 'invalid options' ? { unsafe: true } : {} })).rejects.toBeDefined();
    expect(starts).toHaveLength(0); expect((await row()).state).toBe('open');
    expect([...native.files.values()].every(value => value.state === 'free')).toBe(true);
  });

  it('pre-exec waits actual ingress terminal before durable cohort validation', async () => {
    const a = await create(); const released = gate(); allGates.push(released);
    let handle;
    const uploadLifetime = ingress.withIngress(async () => {
      handle = await a.coordinator.start({ archivePath: await upload(), operatorId: 10 });
      await released.promise;
    });
    await waitState('restoring');
    expect(starts).toHaveLength(1);
    terminal.resolve();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await row()).state).toBe('restoring');
    expect(await db('portable_restore_commits').count('* as count').first()).toMatchObject({ count: client === 'pg' ? '0' : 0 });
    released.resolve(); await uploadLifetime; await waitState('restart_required');
    expect((await row()).attempt_id).toBe(handle.attemptId);
  });

  it('full native-style ingress ownership cannot race or lose a new runtime registration', async () => {
    await create();
    const before = await db('portable_restore_instances').count('* as count').first();
    // A separately constructed runtime has no internal reentrant capability.
    const contenderIngress = await fixtureIngress(storage.privateRoot);
    const original = contenderIngress.leases.acquire;
    contenderIngress.leases.acquire = async filename => {
      // Model a distinct actual process contending for the same kernel inode.
      if (filename.endsWith('/upload.lease')) throw Object.assign(new Error('held by native restore'), { code: 'MEDIA_LEASE_BUSY' });
      return original(filename);
    };
    const newcomer = createCoordinator({ database: db, work: createWorkRegistry(), leases: native, worker,
      ingress: contenderIngress.ingress, getStorageIdentity: async () => storage, autoPoll: false });
    await ingress.withIngress(async () => {
      await expect(newcomer.initialize()).rejects.toMatchObject({ code: 'MEDIA_LEASE_BUSY' });
      expect(await db('portable_restore_instances').count('* as count').first()).toEqual(before);
      expect(newcomer.isInitialized()).toBe(false);
    });
    contenderIngress.leases.acquire = original;
    await newcomer.initialize(); await newcomer.stop();
    expect(Number((await db('portable_restore_instances').count('* as count').first()).count)).toBe(Number(before.count) + 1);
  });

  it('trusted tracked startup may restore only before normal readiness, with fresh durable open authority', async () => {
    const cold = await create({ ready: false });
    await expect(cold.coordinator.admitStartupRestore()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await expect(cold.work.runControl(() => cold.coordinator.admitStartupRestore())).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await expect(cold.work.track('shipped runtime startup', () => cold.coordinator.admitStartupRestore())).resolves.toBeUndefined();
    cold.coordinator.markReady();
    await expect(cold.work.track('ordinary ready request', () => cold.coordinator.admitStartupRestore())).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await cold.coordinator.admitUpload();
  });

  it.each(['fenced', 'generation', 'volume', 'invalid metadata'])('startup restore rejects changed durable %s authority before mutation', async changed => {
    const cold = await create({ ready: false });
    const current = await row();
    await db('portable_restore_control').where({ id: 1 }).update(changed === 'fenced'
      ? { state: 'recovery_required', epoch: crypto.randomUUID(), attempt_id: crypto.randomUUID(), owner_instance_id: crypto.randomUUID() } : changed === 'generation'
        ? { generation: current.generation + 1 } : changed === 'volume' ? { storage_id: crypto.randomUUID() } : { format_version: 999 });
    await expect(cold.work.track('shipped runtime startup', () => cold.coordinator.admitStartupRestore()))
      .rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    expect(cold.work.isClosed()).toBe(true);
    expect(starts).toHaveLength(0); expect(recoveries).toHaveLength(0);
  });

  it('uninitialized, offline and drained startup callers have no native boot authority', async () => {
    const freshWork = createWorkRegistry();
    const fresh = createCoordinator({ database: db, work: freshWork, leases: native, worker, ingress,
      getStorageIdentity: async () => storage, autoPoll: false });
    await expect(freshWork.track('fake startup', () => fresh.admitStartupRestore())).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    const offline = await create({ offline: true });
    await expect(offline.work.track('offline job', () => offline.coordinator.admitStartupRestore())).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    const cold = await create({ ready: false });
    await cold.work.track('already accepted startup', async () => {
      cold.work.closeAdmission();
      await expect(cold.coordinator.admitStartupRestore()).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    });
  });

  it('offline verified rollback rejects its sanitized typed error and retains the restart barrier', async () => {
    const offline = await create({ offline: true });
    terminal.result = { outcome: 'rolled_back', attemptId: null, proof: 'kernel_lease_released',
      error: { code: 'RESTORE_ARCHIVE_INVALID', statusCode: 413, message: 'Archive limit exceeded' } };
    worker.startWorker.mockImplementation(async args => {
      await args.onStart(); return { ...terminal.result, attemptId: args.attemptId };
    });
    await expect(offline.coordinator.restoreOffline({ archivePath: await upload(), operatorId: 10 }))
      .rejects.toMatchObject({ statusCode: 413, code: 'RESTORE_ARCHIVE_INVALID' });
    expect((await row()).state).toBe('restart_required');
    expect([...native.files.values()].every(value => value.state === 'free')).toBe(true);
  });

  it('offline committed result preserves compatible summary but never clears a restart barrier itself', async () => {
    const offline = await create({ offline: true }); terminal.resolve();
    const result = await offline.coordinator.restoreOffline({ archivePath: await upload(), operatorId: 10 });
    expect(result).toMatchObject({ restored: true, externalPathsConverted: true, filesRestored: 2, restartRequired: true });
    expect((await row()).state).toBe('restart_required');
  });
});
