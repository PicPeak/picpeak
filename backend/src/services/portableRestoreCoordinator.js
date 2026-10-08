'use strict';

const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const applicationWork = require('./activeApplicationWork');
const restorePaths = require('./portableRestorePaths');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(['open', 'draining', 'restoring', 'recovery_required', 'restart_required']);
const CONTROL = 'portable_restore_control';
const INSTANCES = 'portable_restore_instances';
const MAX_JSON_BYTES = 8192;
const MAINTENANCE_MESSAGE = 'Application work is paused for coordinated restore';
let unstartedServerFixture = false;

function enterUnstartedServerFixtureContext() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Unstarted server fixture authority is test-only');
  unstartedServerFixture = true;
}

function failure(message = MAINTENANCE_MESSAGE, code = 'RESTORE_MAINTENANCE', statusCode = 503) {
  return new AppError(message, statusCode, code);
}
function parse(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_JSON_BYTES) throw failure('Restore control metadata is invalid');
  try { return JSON.parse(value); } catch (_) { throw failure('Restore control metadata is invalid'); }
}
function json(value) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw failure('Restore control metadata exceeds its bound');
  return encoded;
}
function tokenHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function validIdentity(value) {
  return value && typeof value.path === 'string' && path.isAbsolute(value.path) && value.path.length <= 2048
    && ['device', 'inode', 'filesystem'].every(key => typeof value[key] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value[key]));
}
function descriptor(value) {
  if (!validIdentity(value)) throw failure('Kernel lifetime lease identity is unavailable', 'RESTORE_LEASE_UNAVAILABLE');
  return { path: value.path, device: value.device, inode: value.inode, filesystem: value.filesystem };
}
function controlRow(row) {
  if (!row || row.id !== 1 || row.format_version !== 1 || !UUID.test(row.storage_id)
    || !STATES.has(row.state) || !Number.isSafeInteger(row.generation) || row.generation < 0
    || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision >= 2147483647) throw failure('Restore control row is invalid');
  if (row.state !== 'open' && (!UUID.test(row.epoch) || !UUID.test(row.attempt_id) || !UUID.test(row.owner_instance_id))) {
    throw failure('Restore epoch metadata is invalid');
  }
  return row;
}
function summary(value = {}) {
  const output = {};
  if (!value || typeof value !== 'object') return output;
  for (const key of ['tables', 'filesRestored']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) output[key] = value[key];
  for (const key of ['usesExternalMedia', 'crossEngine', 'sessionInvalidated']) if (typeof value[key] === 'boolean') output[key] = value[key];
  return output;
}
function terminalError(value) {
  if (!value || typeof value.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(value.code)
    || !Number.isInteger(value.statusCode) || value.statusCode < 400 || value.statusCode > 599
    || typeof value.message !== 'string' || value.message.length > 512) return null;
  return { code: value.code, statusCode: value.statusCode, message: value.message };
}


function createCoordinator({ database, work = applicationWork, leases, worker, ingress, stopServices,
  getStorageIdentity = restorePaths.storageIdentity,
  pollInterval = 1000, offline = false, autoPoll = true } = {}) {
  let registration = null;
  let lifetimeLease = null;
  let location = null;
  let identity = null;
  let initialized = false;
  let locallyReady = false;
  let startupAdmitted = false;
  let drainedAfterAdmission = false;
  let temporaryPause = null;
  let quiescence = null;
  let polling = null;
  let activeTick = null;
  let workerRunning = null;
  let stopping = false;
  const db = () => database || require('../database/db').db;
  const leaseService = () => leases || require('./linuxKernelLease');
  const workerService = () => worker || require('./portableRestoreWorker');
  const ingressService = () => ingress || require('./portableRestoreIngress');
  const control = fn => work.runControl(fn);
  const read = () => control(async () => controlRow(await db()(CONTROL).where({ id: 1 }).first()));

  async function cas(row, changes) {
    return control(() => db()(CONTROL).where({ id: 1, revision: row.revision, state: row.state, epoch: row.epoch })
      .update({ ...changes, revision: row.revision + 1, updated_at: db().fn.now() }));
  }
  async function schema() {
    // Concurrent first boot can race CREATE TABLE. Only a positively complete
    // expected schema permits continuing; another error remains fail-closed.
    try { await control(() => require('../../migrations/core/280_portable_restore_control').up(db())); }
    catch (error) {
      for (const [table, columns] of [[CONTROL, ['storage_id', 'epoch', 'revision', 'worker_lease_json']],
        [INSTANCES, ['lease_json', 'host_id', 'startup_ready_epoch']], ['portable_restore_commits', ['attempt_id', 'format_version', 'options_digest']]]) {
        if (!(await control(() => db().schema.hasTable(table)))) throw error;
        for (const column of columns) if (!(await control(() => db().schema.hasColumn(table, column)))) throw error;
      }
    }
  }
  async function initialize() {
    if (initialized) return;
    const storage = await getStorageIdentity({ create: true });
    identity = { hostId: storage.identity.host, bootId: storage.identity.bootId };
    location = { ...storage, maintenance: storage.privateRoot };
    // Native restore preserves target control metadata while holding this same
    // actual volume slot. No new runtime registration may be lost between its
    // snapshot and database replacement/replay. Bootstrap requires no ordinary
    // admission, and creates neither jobs nor a listener while waiting/denied.
    await ingressService().withIngress(async () => {
      await schema();
      let row = await control(() => db()(CONTROL).where({ id: 1 }).first());
      if (!row) {
        try { await control(() => db()(CONTROL).insert({ id: 1, storage_id: location.storageId })); }
        catch (error) { if (!(await control(() => db()(CONTROL).where({ id: 1 }).first()))) throw error; }
      }
      row = await read();
      if (row.storage_id !== location.storageId) throw failure('Storage is not the authoritative shared restore mount', 'RESTORE_STORAGE_MISMATCH');
      const instanceId = crypto.randomUUID();
      lifetimeLease = await leaseService().acquire(path.join(location.maintenance, 'runtime', `${instanceId}.lease`));
      const lease = descriptor(lifetimeLease);
      registration = { instance_id: instanceId, generation: row.generation + (row.state === 'open' || row.state === 'restart_required' ? 0 : 1),
        storage_id: location.storageId, host_id: identity.hostId, boot_id: identity.bootId, lease_json: json(lease) };
      // Register against a locked current control row, not the pre-acquire
      // snapshot. A cold runtime racing a new epoch cannot join an old cohort
      // and initialize after that cohort was already declared quiescent.
      row = await control(() => db().transaction(async trx => {
        let query = trx(CONTROL).where({ id: 1 });
        if (trx.client.config.client === 'pg') query = query.forUpdate();
        const latest = controlRow(await query.first());
        if (latest.storage_id !== location.storageId) throw failure('Restore storage identity changed');
        registration.generation = latest.generation + (latest.state === 'open' || latest.state === 'restart_required' ? 0 : 1);
        await trx(INSTANCES).insert(registration);
        return latest;
      }));
      initialized = true;
      if (row.state !== 'open') work.closeAdmission();
    });
    // Caller creates the polling owner outside runControl. It never gives
    // timer callbacks, stopped services or normal startup that capability.
    startPolling();
    await tick();
  }
  async function proveFree(instance) {
    if (!restorePaths.sameRuntimeVolume(location, instance)) return 'unknown';
    // The same kernel boot UUID plus matching shared inode/free flock proves
    // terminal even in containers without machine-id. A changed boot needs an
    // authoritative persistent SAME host identity, never a hostname or TTL.
    return leaseService().probe(parse(instance.lease_json).path, descriptor(parse(instance.lease_json)));
  }
  function closeForKnownFence() {
    if (startupAdmitted) drainedAfterAdmission = true;
    temporaryPause = null;
    work.closeAdmission(); locallyReady = false;
  }
  function pauseForControlRead() {
    if (!offline && startupAdmitted && !drainedAfterAdmission && !stopping
      && (temporaryPause || !work.isClosed())) temporaryPause ||= { ready: locallyReady };
    work.closeAdmission(); locallyReady = false;
  }
  async function liveOpenProof(row) {
    if (stopping || drainedAfterAdmission || row.state !== 'open'
      || row.generation !== registration.generation || row.storage_id !== location.storageId) return false;
    const storage = await getStorageIdentity({ create: false });
    if (['root', 'privateRoot', 'storageId', 'device', 'filesystem'].some(key => storage[key] !== location[key])
      || storage.identity.host !== identity.hostId || storage.identity.bootId !== identity.bootId) return false;
    const stored = await control(() => db()(INSTANCES).where({ instance_id: registration.instance_id }).first());
    if (!stored || ['instance_id', 'generation', 'storage_id', 'host_id', 'boot_id', 'lease_json', 'ack_epoch', 'startup_ready_epoch']
      .some(key => (stored[key] ?? null) !== (registration[key] ?? null))
      || !restorePaths.sameRuntimeVolume(storage, stored) || (await proveFree(stored)) !== 'busy') return false;
    const latest = await read();
    return !stopping && !drainedAfterAdmission && latest.state === 'open'
      && ['storage_id', 'generation', 'revision', 'epoch'].every(key => latest[key] === row[key]);
  }
  async function resumeReadPause(row) {
    if (!temporaryPause || !startupAdmitted || offline || !(await liveOpenProof(row))) return false;
    const ready = temporaryPause.ready;
    temporaryPause = null; work.openAdmission(); locallyReady = ready;
    return true;
  }
  async function visitInstances(where, visit, connection = db()) {
    let last = '';
    for (;;) {
      const rows = await control(() => connection(INSTANCES).where(where).where('instance_id', '>', last).orderBy('instance_id').limit(100));
      for (const row of rows) if (!(await visit(row))) return false;
      if (rows.length < 100) return true;
      last = rows[rows.length - 1].instance_id;
    }
  }
  async function quiesce(row) {
    closeForKnownFence();
    if (!quiescence) quiescence = work.runUncontrolled(async () => {
      await (stopServices || require('./serviceShutdown').stopServices)();
      await work.drain();
      // An already admitted startup may have constructed a resource after the
      // first shutdown snapshot. Once its owner is drained, stop that complete
      // snapshot too before publishing any quiescence ACK.
      await (stopServices || require('./serviceShutdown').stopServices)();
      await work.drain();
    });
    await quiescence;
    if ((await control(() => db()(INSTANCES).where({ instance_id: registration.instance_id })
      .update({ ack_epoch: row.epoch }))) !== 1) throw failure('Runtime registration disappeared before its ACK');
    registration.ack_epoch = row.epoch;
  }
  async function allQuiescent(row) {
    return visitInstances({}, async instance => {
      const proof = await proveFree(instance);
      return proof === 'free' || (proof === 'busy' && instance.ack_epoch === row.epoch
        && (instance.instance_id === registration.instance_id || !offline));
    });
  }
  async function validateStart({ attemptId, epoch }) {
    await ingressService().drain();
    const row = await read();
    if (row.attempt_id !== attemptId || row.epoch !== epoch || row.owner_instance_id !== registration.instance_id
      || row.state !== 'restoring' || !(await allQuiescent(row))) throw failure('Restore worker admission was superseded');
    return true;
  }
  async function recordTerminal(row, result, recovery) {
    if (!result || result.attemptId !== row.attempt_id || result.proof !== 'kernel_lease_released'
      || !['committed', 'rolled_back', 'recovery_required'].includes(result.outcome)) throw failure('Restore worker terminal proof is unavailable');
    if ((await workerService().probeWorkerLease(descriptor(parse(row.worker_lease_json)))) !== 'free') {
      throw failure('Restore worker lifetime remains unknown');
    }
    const latest = await read();
    if (latest.attempt_id !== row.attempt_id || latest.epoch !== row.epoch || latest.owner_instance_id !== registration.instance_id) throw failure('Restore terminal result belongs to a superseded epoch');
    if (result.outcome === 'committed') {
      const marker = await control(() => db()('portable_restore_commits').where({ attempt_id: row.attempt_id, format_version: 1 }).first());
      if (!marker || !/^[0-9a-f]{64}$/.test(marker.local_plan_checksum || '')
        || marker.options_digest !== tokenHash(row.options_json)) throw failure('Matching restore commit marker is unavailable');
      const hasS3 = marker.s3_namespace !== null || marker.s3_revision !== null || marker.s3_manifest_checksum !== null;
      if (hasS3 && (typeof marker.s3_namespace !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(marker.s3_namespace)
        || !/^[0-9a-f]{64}$/.test(marker.s3_manifest_checksum || '')
        || !UUID.test(marker.s3_revision || ''))) {
        throw failure('Restore S3 commit marker is invalid');
      }
    }
    const complete = result.outcome !== 'recovery_required';
    await cas(latest, { state: complete ? 'restart_required' : 'recovery_required',
      generation: complete ? latest.generation + 1 : latest.generation,
      result_json: json({ outcome: result.outcome, ...summary(result.summary), error: terminalError(result.error), recoveryAttempted: recovery }) });
  }
  async function execute(row, recovery) {
    try {
      const lease = descriptor(parse(row.worker_lease_json));
      const args = { attemptId: row.attempt_id, epoch: row.epoch, workerLeaseDescriptor: lease,
        onStart: () => validateStart({ attemptId: row.attempt_id, epoch: row.epoch }) };
      const result = recovery
        ? await workerService().recoverWorker(args)
        : await workerService().startWorker({ ...args, archivePath: row.archive_path,
          operatorId: row.operator_id, options: parse(row.options_json) });
      await recordTerminal(row, result, recovery);
    } catch (error) {
      logger.error('Coordinated restore requires recovery', { attemptId: row.attempt_id, code: error.code || 'RESTORE_RECOVERY_REQUIRED' });
      const latest = await read();
      if (latest.epoch === row.epoch && latest.owner_instance_id === registration.instance_id) {
        await cas(latest, { state: 'recovery_required', result_json: json({ outcome: 'recovery_required', recoveryAttempted: recovery }) });
      }
    }
  }
  async function reconcileRestart(row) {
    if (registration.generation !== row.generation) return;
    if ((await control(() => db()(INSTANCES).where({ instance_id: registration.instance_id })
      .update({ startup_ready_epoch: row.epoch }))) !== 1) throw failure('Runtime registration disappeared before startup ACK');
    registration.startup_ready_epoch = row.epoch;
    await control(() => db().transaction(async trx => {
      // This WRITE/row lock is also acquired by registration. It closes the
      // SELECT-cohort / CAS-open gap: no unacknowledged cold registration can
      // slip between the proofs and the durable opening transition.
      if (!(await trx(CONTROL).where({ id: 1, revision: row.revision, state: 'restart_required', epoch: row.epoch })
        .update({ revision: row.revision }))) return;
      const oldGone = await visitInstances(builder => builder.where('generation', '<', row.generation),
        async instance => (await proveFree(instance)) === 'free', trx);
      if (!oldGone) return;
      const newReady = await visitInstances({ generation: row.generation },
        async instance => {
          const proof = await proveFree(instance);
          return proof === 'free' || (proof === 'busy' && instance.startup_ready_epoch === row.epoch);
        }, trx);
      if (newReady) await trx(CONTROL).where({ id: 1, revision: row.revision, state: 'restart_required', epoch: row.epoch })
        .update({ state: 'open', owner_instance_id: null, revision: row.revision + 1, updated_at: trx.fn.now() });
    }));
  }
  async function tickInternal() {
    if (!initialized || stopping) return;
    let row;
    try { row = await read(); }
    catch (error) { pauseForControlRead(); throw error; }
    if (row.state === 'open') {
      if (row.generation !== registration.generation || row.storage_id !== location.storageId) closeForKnownFence();
      else await resumeReadPause(row);
      return;
    }
    await quiesce(row);
    if (row.state === 'restart_required') return reconcileRestart(row);
    if (workerRunning) return;
    if (row.owner_instance_id === registration.instance_id && row.state === 'draining') {
      if (!(await allQuiescent(row))) return;
      if (!(await cas(row, { state: 'restoring' }))) return;
      const admitted = await read();
      workerRunning = work.runUncontrolled(() => execute(admitted, false)).finally(() => { workerRunning = null; });
      return;
    }
    if (row.owner_instance_id === registration.instance_id && row.state === 'recovery_required') {
      // Node terminal does not prove a remote COMMIT terminal. The worker's
      // recovery path must acquire the SAME database transaction lock before
      // consulting the marker or restoring files. Never infer rollback here.
      if (row.result_json && parse(row.result_json).recoveryAttempted === true) return;
      if (!(await allQuiescent(row))
        || (await workerService().probeWorkerLease(descriptor(parse(row.worker_lease_json)))) !== 'free') return;
      if (!(await cas(row, { state: 'restoring' }))) return;
      const admitted = await read();
      workerRunning = work.runUncontrolled(() => execute(admitted, true)).finally(() => { workerRunning = null; });
      return;
    }
    // Even an old worker's free lease does not prove its live parent cannot
    // launch later. First prove actual owner lifetime terminal, then CAS and
    // revalidate the new epoch at the supervised pre-exec gate.
    const owner = await control(() => db()(INSTANCES).where({ instance_id: row.owner_instance_id }).first());
    if (!owner || (await proveFree(owner)) !== 'free' || !(await allQuiescent(row))) return;
    const lease = descriptor(parse(row.worker_lease_json));
    if ((await workerService().probeWorkerLease(lease)) !== 'free') return;
    if (!(await cas(row, { state: 'restoring', owner_instance_id: registration.instance_id }))) return;
    const admitted = await read();
    workerRunning = work.runUncontrolled(() => execute(admitted, true)).finally(() => { workerRunning = null; });
  }
  function tick() {
    if (!activeTick) activeTick = work.runUncontrolled(tickInternal).catch(error => {
      work.closeAdmission(); locallyReady = false;
      logger.error('Restore coordinator stays fenced', { code: error.code || 'RESTORE_CONTROL_UNAVAILABLE' });
    }).finally(() => { activeTick = null; });
    return activeTick;
  }
  function startPolling() {
    if (polling || stopping || !autoPoll) return;
    work.runUncontrolled(() => {
      polling = setInterval(() => { void tick(); }, pollInterval);
      polling.unref();
    });
  }
  async function waitForStartupAdmission() {
    if (!initialized) throw failure();
    for (;;) {
      if (stopping) throw failure();
      const row = await read();
      if (drainedAfterAdmission) throw failure();
      if (startupAdmitted && work.isClosed() && !temporaryPause) throw failure();
      if (row.state === 'open' && row.generation === registration.generation && row.storage_id === location.storageId
        && await liveOpenProof(row)) {
        // This is only a newly registered cold runtime, never a drained old
        // cohort member. Existing runtimes cannot reopen without restarting.
        if (temporaryPause) locallyReady = temporaryPause.ready;
        temporaryPause = null; quiescence = null; startupAdmitted = true;
        work.openAdmission();
        return;
      }
      await tick();
      if (stopping) throw failure();
      await new Promise(resolve => work.runUncontrolled(() => setTimeout(resolve, pollInterval)));
    }
  }
  async function admitRequest() {
    if (!initialized && process.env.NODE_ENV === 'test' && unstartedServerFixture) return;
    if (!initialized || !locallyReady) throw failure();
    const row = await read();
    if (row.state !== 'open' || row.generation !== registration.generation || row.storage_id !== location.storageId) {
      closeForKnownFence();
      void tick();
      throw failure();
    }
  }
  async function admitStartupRestore() {
    // Only the shipped boot restore's existing ordinary startup owner may use
    // this internal entry. A control HTTP request, missing scope, ready server
    // or drained old owner cannot manufacture startup authority.
    if (!initialized || offline || locallyReady || work.isClosed() || work.isControl() || !work.hasScope()) throw failure();
    let row;
    try { row = await read(); }
    catch (_) { pauseForControlRead(); void tick(); throw failure(); }
    if (row.state !== 'open' || row.generation !== registration.generation || row.storage_id !== location.storageId) {
      closeForKnownFence();
      void tick();
      throw failure();
    }
  }
  async function revalidateAfterNativeRestore() {
    // Only a terminal native/boot restore's existing ordinary owner calls this
    // inside its shared ingress slot. It cannot turn a known drain into OPEN,
    // invent startup admission, or infer database/worker terminal from a lease.
    if (!initialized || offline || !startupAdmitted || stopping || drainedAfterAdmission
      || work.isControl() || !work.hasScope()) throw failure();
    let row;
    try { row = await read(); }
    catch (_) { pauseForControlRead(); throw failure(); }
    if (row.state !== 'open' || row.generation !== registration.generation || row.storage_id !== location.storageId) {
      closeForKnownFence(); throw failure();
    }
    let proven = false;
    try { proven = await liveOpenProof(row); } catch (_) { /* Unavailable runtime proof stays closed. */ }
    if (!proven) { work.closeAdmission(); locallyReady = false; throw failure(); }
    if (temporaryPause) {
      locallyReady = temporaryPause.ready; temporaryPause = null; work.openAdmission();
    }
    if (work.isClosed()) throw failure();
  }
  async function reserveRestore({ archivePath, operatorId, options = {} }) {
    if (!initialized || (!offline && !locallyReady) || (!offline && (!Number.isSafeInteger(operatorId) || operatorId <= 0))) throw failure();
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !offline || key !== 'migrationStorageIndexPath')
      || (options.migrationStorageIndexPath !== undefined && (typeof options.migrationStorageIndexPath !== 'string'
        || !path.isAbsolute(options.migrationStorageIndexPath) || options.migrationStorageIndexPath.length > 2048))) {
      throw failure('Unsupported portable restore options', 'RESTORE_OPTIONS_INVALID', 400);
    }
    const handle = await ingressService().withIngress(async () => {
      const row = await read();
      if (row.state !== 'open' || registration.generation !== row.generation) throw failure('A coordinated restore is already active', 'RESTORE_CONFLICT', 409);
      if (offline && !(await visitInstances({}, async instance => instance.instance_id === registration.instance_id || (await proveFree(instance)) === 'free'))) {
        throw failure('Offline restore requires positive terminal proof for every other runtime');
      }
      const attemptId = crypto.randomUUID();
      const epoch = crypto.randomUUID();
      const progressToken = crypto.randomBytes(32).toString('hex');
      const lease = descriptor(await workerService().workerLeaseDescriptor({ attemptId }));
      const expected = path.join(location.maintenance, attemptId, 'worker.lease');
      if (lease.path !== expected) throw failure('Worker lease is outside its owned restore directory');
      const staged = path.join(path.dirname(expected), 'request.picpeak');
      const copied = await ingressService().copyArchive({ sourcePath: archivePath, destinationPath: staged });
      try {
        if (!(await cas(row, { state: 'draining', epoch, attempt_id: attemptId, owner_instance_id: registration.instance_id,
          archive_path: staged, operator_id: Number.isSafeInteger(operatorId) && operatorId > 0 ? operatorId : null,
          options_json: json(options), worker_lease_json: json(lease),
          progress_token_hash: tokenHash(progressToken), result_json: null }))) {
          throw failure('A coordinated restore is already active', 'RESTORE_CONFLICT', 409);
        }
        copied.retain();
      } catch (error) {
      // An uncertain remote CAS may already have claimed this exact archive.
      // Never unlink it on an inferred preclaim failure or unavailable read.
        try { if ((await read()).archive_path === staged) copied.retain(); }
        catch (_) { copied.retain(); }
        throw error;
      }
      return { attemptId, progressToken, state: 'draining', restartRequired: true };
    });
    // No ordinary HTTP owner contains this control request. Launching its
    // drain cannot wait for the same request/upload to finish its own response.
    void work.runUncontrolled(tick);
    return handle;
  }
  async function start(args) {
    if (offline) throw failure('Offline authority is not an HTTP restore admission');
    return reserveRestore(args);
  }
  async function restoreOffline(args) {
    if (!offline) throw failure('Offline restore requires its private coordinator');
    try {
      await initialize();
      // Only positive lifetime-free evidence, never another live runtime's ACK,
      // admits an offline caller. It cannot ask that runtime to stop serving.
      if (!(await visitInstances({}, async instance => instance.instance_id === registration.instance_id || (await proveFree(instance)) === 'free'))) {
        await stop();
        await lifetimeLease.release();
        throw failure('Offline restore cannot run while another runtime may be alive');
      }
      await waitForStartupAdmission();
      work.closeAdmission();
      const handle = await reserveRestore(args);
      for (;;) {
        await tick();
        const row = await read();
        if (row.attempt_id !== handle.attemptId) throw failure('Offline restore attempt was superseded');
        if (row.state === 'restart_required' || (row.state === 'recovery_required' && !workerRunning)) {
          const result = row.result_json ? parse(row.result_json) : {};
          // A positively terminal failed start is followed by one supervised
          // recovery, including the database lock proof. Give tick that owned
          // transition even if execute's finally settled after the last tick.
          if (row.state === 'recovery_required' && result.recoveryAttempted !== true
          && (await workerService().probeWorkerLease(descriptor(parse(row.worker_lease_json)))) === 'free') continue;
          await stop();
          await work.drain();
          if ((await workerService().probeWorkerLease(descriptor(parse(row.worker_lease_json)))) !== 'free') {
            throw failure('Offline worker lifetime remains unknown');
          }
          await lifetimeLease.release();
          if (row.state !== 'restart_required') throw failure('Offline restore requires supervised recovery');
          if (result.outcome === 'rolled_back') {
            const error = terminalError(result.error);
            throw error ? failure(error.message, error.code, error.statusCode) : failure('Restore failed; prior data was verified', 'RESTORE_ROLLED_BACK', 400);
          }
          return { ...summary(result), restored: true, externalPathsConverted: true, externalPathError: null,
            outcome: result.outcome, restartRequired: true, attemptId: handle.attemptId };
        }
        if (stopping) throw failure();
        await new Promise(resolve => work.runUncontrolled(() => setTimeout(resolve, pollInterval)));
      }
    } catch (error) {
      await stop();
      await work.drain();
      await ingressService().drain();
      // Release only a positively unclaimed private runtime. If control reads
      // or a CAS are uncertain, or this runtime owns a fenced attempt, actual
      // Node death / verified worker terminal remains the only release proof.
      if (lifetimeLease) {
        try {
          const row = await read();
          if (row.owner_instance_id !== registration?.instance_id || row.state === 'open') await lifetimeLease.release();
        } catch (_) { /* Unknown durable authority keeps the runtime FD. */ }
      }
      throw error;
    }
  }
  async function progress(attemptId, token, authenticatedSuperAdmin = false) {
    if (!UUID.test(attemptId)) throw failure('Restore attempt not found', 'RESTORE_NOT_FOUND', 404);
    const row = await read();
    let matches = false;
    if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) && /^[0-9a-f]{64}$/.test(row.progress_token_hash || '')) {
      matches = crypto.timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(row.progress_token_hash, 'hex'));
    }
    if (row.attempt_id !== attemptId || (!authenticatedSuperAdmin && !matches)) throw failure('Restore attempt not found', 'RESTORE_NOT_FOUND', 404);
    const result = row.result_json ? parse(row.result_json) : null;
    return { attemptId, state: row.state, outcome: result?.outcome || null, summary: summary(result),
      restartRequired: row.state === 'restart_required', complete: row.state === 'open' && !!result };
  }
  async function stop() {
    stopping = true;
    clearInterval(polling); polling = null;
    await activeTick;
    // The runtime FD deliberately remains held until actual Node lifetime
    // ends. A hung/unknown worker must not be mistaken for a dead runtime.
  }
  return { initialize, waitForStartupAdmission, admitRequest, admitUpload: admitRequest, admitStartupRestore, revalidateAfterNativeRestore, start, progress, tick, stop,
    restoreOffline,
    markReady: () => {
      if (!startupAdmitted || drainedAfterAdmission || stopping) throw failure();
      if (temporaryPause) temporaryPause.ready = true;
      else if (!work.isClosed()) locallyReady = true;
      else throw failure();
    }, validateStart,
    // Presentation hint only: ordinary requests still require fresh durable
    // admission. A healthy UI must use normal branding/headers/compression.
    isReady: () => initialized && locallyReady && !work.isClosed() && !stopping,
    instanceId: () => registration?.instance_id, isInitialized: () => initialized };
}

const coordinator = createCoordinator();
async function restoreOffline({ archivePath, currentAdminId, options = {} }) {
  if (coordinator.isInitialized()) throw failure('Offline restore is unavailable in an initialized server runtime');
  const offlineCoordinator = createCoordinator({ offline: true, work: applicationWork.createWorkRegistry(), stopServices: async () => {} });
  return offlineCoordinator.restoreOffline({ archivePath, operatorId: currentAdminId, options });
}
module.exports = { ...coordinator, restoreOffline, createCoordinator, enterUnstartedServerFixtureContext };
