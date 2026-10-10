'use strict';

const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const applicationWork = require('./activeApplicationWork');
const restorePaths = require('./portableRestorePaths');
const restoreCapability = require('./portableRestoreCapability');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(['open', 'draining', 'restoring', 'recovery_required', 'restart_required']);
const CONTROL = 'portable_restore_control';
const INSTANCES = 'portable_restore_instances';
const MAX_JSON_BYTES = 8192;
const MAINTENANCE_MESSAGE = 'Application work is paused for coordinated restore';
// A registered runtime refreshes its row this often; one whose kernel lease
// cannot be probed and whose row is older than the stale bound is dead.
const HEARTBEAT_MS = 20 * 1000;
const HEARTBEAT_STALE_MS = 90 * 1000;
// A fence marker left behind without a fenced control row is corrected once
// it is this old (a restore being reserved writes it moments before its row).
const MARKER_REPAIR_MS = 30 * 1000;

function duration(name, fallback) {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
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
// What a caught error may say in the control row and on the progress route.
function describeError(error, fallback) {
  return terminalError({ code: /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : fallback,
    statusCode: Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500,
    message: String(error?.message || fallback).slice(0, 512) });
}



// Coordinated restore is a capability, never a startup requirement. A runtime
// does nothing until a restore is reserved or a fence marker appears in shared
// storage: no directory, no lease, no control row and no database query. Only
// then does it register, stop its services and acknowledge the fence.
function createCoordinator({ database, work = applicationWork, leases, worker, ingress, stopServices, resumeServices, forceClose,
  capability = restoreCapability, fence = { read: restorePaths.readFence, write: restorePaths.writeFence },
  cleanup = { attempt: restorePaths.cleanAttempt, leftovers: restorePaths.reapLeftovers },
  getStorageIdentity = restorePaths.storageIdentity, now = () => Date.now(),
  pollInterval = 1000, markerInterval = 2000, settleMs,
  drainGraceMs = duration('PICPEAK_RESTORE_DRAIN_GRACE_MS', 60000), forceGraceMs = 10000,
  offline = false, autoPoll = true } = {}) {
  let capabilityState = null;
  let activated = false;
  let registration = null;
  let registering = null;
  let lifetimeLease = null;
  let location = null;
  let identity = null;
  let initialized = false;
  // The fence generation this process started under. A higher one means the
  // database was replaced while this process kept its caches: it must restart.
  let baseline = 0;
  let stale = false;
  let pendingStartup = false;
  let unjoined = false;
  let servicesStopped = false;
  let acknowledged = null;
  let quiescence = null;
  let drainingSince = null;
  let lastHeartbeat = 0;
  let watching = null;
  let polling = null;
  let activeTick = null;
  let activeWatch = null;
  let workerRunning = null;
  let stopping = false;
  const hooks = { stopServices, resumeServices, forceClose };
  const settle = settleMs === undefined ? 2 * markerInterval + 1000 : settleMs;
  const db = () => database || require('../database/db').db;
  const leaseService = () => leases || require('./linuxKernelLease');
  const workerService = () => worker || require('./portableRestoreWorker');
  const ingressService = () => ingress || require('./portableRestoreIngress');
  const control = fn => work.runControl(fn);
  const read = () => control(async () => controlRow(await db()(CONTROL).where({ id: 1 }).first()));
  const available = () => capabilityState?.available === true;

  async function cas(row, changes) {
    return control(() => db()(CONTROL).where({ id: 1, revision: row.revision, state: row.state, epoch: row.epoch })
      .update({ ...changes, revision: row.revision + 1, updated_at: db().fn.now() }));
  }
  async function schema() {
    // The migration normally created these. A runtime that boots into a fence
    // left by a previous run reads them before migrations run, and concurrent
    // first use can race CREATE TABLE: only a complete schema may continue.
    try { await control(() => require('../../migrations/core/249_portable_restore_control').up(db())); }
    catch (error) {
      for (const [table, columns] of [[CONTROL, ['storage_id', 'epoch', 'revision', 'worker_lease_json']],
        [INSTANCES, ['lease_json', 'host_id', 'startup_ready_epoch', 'heartbeat_at']], ['portable_restore_commits', ['attempt_id', 'format_version', 'options_digest']]]) {
        if (!(await control(() => db().schema.hasTable(table)))) throw error;
        for (const column of columns) if (!(await control(() => db().schema.hasColumn(table, column)))) throw error;
      }
    }
  }
  function markStale() {
    if (!stale) logger.warn('A portable restore replaced the database under this process; restart the backend to serve the restored data');
    stale = true;
    work.closeAdmission();
  }

  // Registration happens on first use: the runtime that reserves a restore,
  // one that sees another runtime's fence marker, or one booting into a fence.
  // `running` runtimes belong to the cohort that must drain; a cold one that
  // registers during a restore belongs to the cohort that starts afterwards.
  function ensureRegistered({ running }) {
    if (initialized) return Promise.resolve();
    registering ||= register({ running }).finally(() => { registering = null; });
    return registering;
  }
  async function register({ running }) {
    const storage = await getStorageIdentity({ create: true });
    identity = { hostId: storage.identity.host, bootId: storage.identity.bootId };
    location = { ...storage, maintenance: storage.privateRoot };
    // Native restore preserves target control metadata while holding this same
    // volume slot, so no registration is lost between its snapshot and replay.
    await ingressService().withIngress(async () => {
      await schema();
      let row = await control(() => db()(CONTROL).where({ id: 1 }).first());
      if (!row) {
        try { await control(() => db()(CONTROL).insert({ id: 1, storage_id: location.storageId })); }
        catch (error) { if (!(await control(() => db()(CONTROL).where({ id: 1 }).first()))) throw error; }
      }
      row = await read();
      if (row.storage_id !== location.storageId) {
        // The storage volume was replaced (new disk, restored volume). With no
        // restore in flight the control row simply follows the storage in use.
        if (row.state !== 'open' || !(await cas(row, { storage_id: location.storageId }))) {
          throw failure('Storage is not the authoritative shared restore mount', 'RESTORE_STORAGE_MISMATCH');
        }
        logger.warn('Portable restore control now follows a replaced storage volume');
      }
      const instanceId = crypto.randomUUID();
      lifetimeLease = await leaseService().acquire(path.join(location.maintenance, 'runtime', `${instanceId}.lease`));
      const lease = descriptor(lifetimeLease);
      const entry = { instance_id: instanceId, generation: row.generation, storage_id: location.storageId,
        host_id: identity.hostId, boot_id: identity.bootId, lease_json: json(lease), heartbeat_at: new Date(now()).toISOString() };
      // Register against a locked current control row, not the pre-acquire
      // snapshot, so a runtime racing a new epoch cannot join an old cohort.
      await control(() => db().transaction(async trx => {
        let query = trx(CONTROL).where({ id: 1 });
        if (trx.client.config.client === 'pg') query = query.forUpdate();
        const latest = controlRow(await query.first());
        if (latest.storage_id !== location.storageId) throw failure('Restore storage identity changed');
        const settled = latest.state === 'open' || latest.state === 'restart_required';
        // A running runtime that only now notices a committed restore is the
        // cohort that restore replaced.
        entry.generation = running ? latest.generation - (latest.state === 'restart_required' ? 1 : 0)
          : latest.generation + (settled ? 0 : 1);
        await trx(INSTANCES).insert(entry);
      }));
      registration = entry;
      lastHeartbeat = now();
      initialized = true;
    });
    await reapDeadInstances().catch(() => {});
  }
  async function heartbeat() {
    if (!initialized || now() - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = now();
    const heartbeat_at = new Date(lastHeartbeat).toISOString();
    await control(() => db()(INSTANCES).where({ instance_id: registration.instance_id }).update({ heartbeat_at }));
    registration.heartbeat_at = heartbeat_at;
  }
  // 'busy' and 'free' are kernel answers. Where the kernel cannot answer (the
  // row is from another boot of an unknown host, its storage was replaced, the
  // lease file is gone) the heartbeat decides, so a crash or reboot in the
  // middle of a restore never leaves a registration nobody can disprove.
  async function proveFree(instance) {
    let proof = 'unknown';
    if (restorePaths.leaseProvable(location, instance)) {
      try {
        const lease = descriptor(parse(instance.lease_json));
        proof = await leaseService().probe(lease.path, lease);
      } catch (_) { proof = 'unknown'; }
    }
    if (proof === 'busy' || proof === 'free') return proof;
    const beat = Date.parse(instance.heartbeat_at || '');
    return Number.isFinite(beat) && now() - beat <= HEARTBEAT_STALE_MS ? 'unknown' : 'free';
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
  async function reapDeadInstances() {
    if (!initialized) return;
    await visitInstances({}, async instance => {
      if (instance.instance_id === registration.instance_id || (await proveFree(instance)) !== 'free') return true;
      await control(() => db()(INSTANCES).where({ instance_id: instance.instance_id }).del());
      try {
        const lease = parse(instance.lease_json).path;
        if (path.dirname(lease) === path.join(location.maintenance, 'runtime')) await require('fs').promises.unlink(lease);
      } catch (_) { /* The row was the claim; a leftover lease file is reaped at boot. */ }
      return true;
    });
  }

  function within(promise, ms) {
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(resolve, ms, false); });
    return Promise.race([promise.then(() => true), expired]).finally(() => clearTimeout(timer));
  }
  // Stop the background services and wait for accepted work. After the grace
  // period the remaining connections are cut, as the shutdown path does; work
  // that still does not end fails the drain instead of holding the fence.
  function quiesceLocal() {
    work.closeAdmission();
    if (!quiescence) {
      quiescence = work.runUncontrolled(async () => {
        if (pendingStartup) return;
        servicesStopped = true;
        const stop = hooks.stopServices || require('./serviceShutdown').stopServices;
        const drained = (async () => {
          await stop();
          await work.drain();
          // An already admitted startup may have constructed a resource after
          // the first shutdown snapshot; stop that complete snapshot too.
          await stop();
          await work.drain();
        })();
        drained.catch(() => {});
        if (await within(drained, drainGraceMs)) return;
        logger.warn('Open requests outlived the restore drain grace; closing their connections', { graceMs: drainGraceMs });
        try { await hooks.forceClose?.(); } catch (error) { logger.warn('Closing connections for the restore drain failed', { error: error.message }); }
        if (await within(drained, forceGraceMs)) return;
        throw failure('Running work did not finish before the restore drain deadline', 'RESTORE_DRAIN_TIMEOUT');
      });
      quiescence.catch(() => { quiescence = null; });
    }
    return quiescence;
  }
  // Only a verified rollback or an aborted drain reopens a runtime that had
  // stopped its services: the data is what it was when they stopped.
  async function resumeLocal() {
    if (stale || pendingStartup || stopping) return;
    quiescence = null; acknowledged = null; drainingSince = null; unjoined = false;
    work.openAdmission();
    if (!servicesStopped) return;
    servicesStopped = false;
    try { await work.runUncontrolled(() => hooks.resumeServices?.()); }
    catch (error) {
      logger.error('Background services did not all restart after the restore ended; restart the backend to bring them back', { error: error.message });
    }
  }
  async function quiesce(row) {
    await quiesceLocal();
    if (acknowledged === row.epoch) return;
    if ((await control(() => db()(INSTANCES).where({ instance_id: registration.instance_id })
      .update({ ack_epoch: row.epoch }))) !== 1) throw failure('Runtime registration disappeared before its ACK');
    registration.ack_epoch = row.epoch;
    acknowledged = row.epoch;
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
  async function tidy(attemptId, committed) {
    try { await cleanup.attempt(attemptId, { committed }); }
    catch (error) { logger.warn('Restore workspace cleanup failed; it is retried at the next start', { error: error.message }); }
  }
  // Nothing was changed yet: the fence is lifted and every runtime resumes.
  async function abort(row, error) {
    if (!(await cas(row, { state: 'open', owner_instance_id: null,
      result_json: json({ outcome: 'aborted', error: describeError(error, 'RESTORE_ABORTED') }) }))) return false;
    logger.warn('Coordinated restore aborted before any data changed', { attemptId: row.attempt_id, code: error.code });
    await fence.write({ fenced: false, generation: row.generation });
    await tidy(row.attempt_id, false);
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
    const body = { outcome: result.outcome, ...summary(result.summary), error: terminalError(result.error), recoveryAttempted: recovery };
    if (result.outcome === 'rolled_back') {
      // The worker restored every file under the database lock and found no
      // commit marker: the instance is exactly what it was. Reopen it.
      if (!body.error) body.error = terminalError({ code: 'RESTORE_ROLLED_BACK', statusCode: 500, message: 'The restore failed and was rolled back' });
      if (await cas(latest, { state: 'open', owner_instance_id: null, result_json: json(body) })) {
        await fence.write({ fenced: false, generation: latest.generation });
        await tidy(row.attempt_id, false);
      }
      return;
    }
    const committed = result.outcome === 'committed';
    await cas(latest, { state: committed ? 'restart_required' : 'recovery_required',
      generation: committed ? latest.generation + 1 : latest.generation, result_json: json(body) });
    if (committed) await tidy(row.attempt_id, true);
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
      if (latest.epoch === row.epoch && latest.owner_instance_id === registration.instance_id && latest.state !== 'open') {
        await cas(latest, { state: 'recovery_required', result_json: json({ outcome: 'recovery_required', recoveryAttempted: recovery,
          error: describeError(error, 'RESTORE_RECOVERY_REQUIRED') }) });
      }
    }
  }
  async function reconcileRestart(row) {
    if ((await control(() => db()(INSTANCES).where({ instance_id: registration.instance_id })
      .update({ startup_ready_epoch: row.epoch }))) !== 1) throw failure('Runtime registration disappeared before startup ACK');
    registration.startup_ready_epoch = row.epoch;
    await reapDeadInstances();
    const opened = await control(() => db().transaction(async trx => {
      // This WRITE/row lock is also acquired by registration. It closes the
      // SELECT-cohort / CAS-open gap: no unacknowledged cold registration can
      // slip between the proofs and the durable opening transition.
      if (!(await trx(CONTROL).where({ id: 1, revision: row.revision, state: 'restart_required', epoch: row.epoch })
        .update({ revision: row.revision }))) return false;
      const oldGone = await visitInstances(builder => builder.where('generation', '<', row.generation),
        async instance => (await proveFree(instance)) === 'free', trx);
      if (!oldGone) return false;
      const newReady = await visitInstances({ generation: row.generation },
        async instance => {
          const proof = await proveFree(instance);
          return proof === 'free' || (proof === 'busy' && instance.startup_ready_epoch === row.epoch);
        }, trx);
      if (!newReady) return false;
      return (await trx(CONTROL).where({ id: 1, revision: row.revision, state: 'restart_required', epoch: row.epoch })
        .update({ state: 'open', owner_instance_id: null, revision: row.revision + 1, updated_at: trx.fn.now() })) === 1;
    }));
    if (opened) {
      await fence.write({ fenced: false, generation: row.generation });
      await tidy(row.attempt_id, true);
    }
  }
  async function tickInternal() {
    if (!initialized || stopping) return;
    let row;
    try { row = await read(); }
    catch (error) {
      // An unreadable control row is no reason to stop serving, unless the
      // marker says a restore is running.
      if ((await fence.read())?.fenced) work.closeAdmission();
      throw error;
    }
    await heartbeat().catch(() => {});
    if (row.state === 'open') {
      if (pendingStartup) {
        if (row.generation < registration.generation) {
          // The restore this cold runtime waited for was rolled back or
          // aborted, so no newer generation exists: it joins the current one.
          await control(() => db()(INSTANCES).where({ instance_id: registration.instance_id }).update({ generation: row.generation }));
          registration.generation = row.generation;
        }
        return;
      }
      if (row.generation !== registration.generation) return markStale();
      if (work.isClosed() || servicesStopped) await resumeLocal();
      const marker = await fence.read();
      if (marker?.fenced && now() - marker.since > MARKER_REPAIR_MS) await fence.write({ fenced: false, generation: row.generation });
      stopPolling();
      return;
    }
    if (row.state === 'restart_required') {
      if (registration.generation !== row.generation) {
        markStale();
        await quiesceLocal().catch(() => {});
        return;
      }
      return reconcileRestart(row);
    }
    const owner = row.owner_instance_id === registration.instance_id;
    try { await quiesce(row); }
    catch (error) {
      if (owner && row.state === 'draining') await abort(row, error);
      throw error;
    }
    if (workerRunning) return;
    if (owner && row.state === 'draining') {
      if (drainingSince?.epoch !== row.epoch) drainingSince = { epoch: row.epoch, at: now() };
      // Other runtimes notice the marker on their next watch; give them that
      // long to register before deciding who has to acknowledge.
      if (now() - drainingSince.at < settle) return;
      if (!(await allQuiescent(row))) {
        if (offline || now() - drainingSince.at > settle + drainGraceMs + forceGraceMs + 5 * pollInterval) {
          await abort(row, failure(offline ? 'Offline restore cannot run while another runtime may be alive'
            : 'Another runtime did not finish its work before the restore drain deadline', 'RESTORE_DRAIN_TIMEOUT'));
        }
        return;
      }
      if (!(await cas(row, { state: 'restoring' }))) return;
      const admitted = await read();
      workerRunning = work.runUncontrolled(() => execute(admitted, false)).finally(() => { workerRunning = null; });
      return;
    }
    if (owner && row.state === 'recovery_required') {
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
    if (owner) return;
    // Even an old worker's free lease does not prove its live parent cannot
    // launch later. First prove actual owner lifetime terminal (a reaped row
    // was proven dead already), then CAS and revalidate the new epoch at the
    // supervised pre-exec gate.
    const holder = await control(() => db()(INSTANCES).where({ instance_id: row.owner_instance_id }).first());
    if ((holder && (await proveFree(holder)) !== 'free') || !(await allQuiescent(row))) return;
    const lease = descriptor(parse(row.worker_lease_json));
    if ((await workerService().probeWorkerLease(lease)) !== 'free') return;
    if (!(await cas(row, { state: 'restoring', owner_instance_id: registration.instance_id }))) return;
    const admitted = await read();
    workerRunning = work.runUncontrolled(() => execute(admitted, true)).finally(() => { workerRunning = null; });
  }
  function tick() {
    if (!activeTick) activeTick = work.runUncontrolled(tickInternal).catch(error => {
      logger.error('Restore coordinator tick failed', { code: error.code || 'RESTORE_CONTROL_UNAVAILABLE', error: error.message });
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
  function stopPolling() { clearInterval(polling); polling = null; }

  // The watch is one small file read per interval and no database query. It
  // is how a runtime that never used the feature learns that another runtime
  // (or the offline tool) started a restore.
  async function watchInternal() {
    if (stopping) return;
    if (initialized) await heartbeat().catch(() => {});
    const marker = await fence.read();
    if (!marker) return;
    if (!marker.fenced) {
      if (pendingStartup) return;
      if (marker.generation > baseline) return markStale();
      if (unjoined) await resumeLocal();
      return;
    }
    try { await ensureRegistered({ running: true }); }
    catch (error) {
      // A fence this runtime cannot join is still a fence: stop, and resume
      // when the marker says the restore ended without replacing the data.
      if (!unjoined) logger.error('A restore is running and this runtime cannot join it; pausing until it ends', { code: error.code, error: error.message });
      unjoined = true;
      await quiesceLocal().catch(() => {});
      return;
    }
    startPolling();
    await tick();
  }
  function watch() {
    if (!activeWatch) activeWatch = work.runUncontrolled(watchInternal).catch(error => {
      logger.warn('Restore fence watch failed', { error: error.message });
    }).finally(() => { activeWatch = null; });
    return activeWatch;
  }
  function startWatching() {
    if (watching || stopping || !autoPoll) return;
    work.runUncontrolled(() => {
      watching = setInterval(() => { void watch(); }, markerInterval);
      watching.unref();
    });
  }

  // Before anything else at boot, and for an install that never restored
  // nothing but one failed file read: did a previous run leave a fence?
  async function pendingAtBoot() {
    const marker = await fence.read();
    if (!marker) return false;
    baseline = marker.generation;
    let row;
    try { row = await control(() => db()(CONTROL).where({ id: 1 }).first()); } catch (_) { return false; }
    if (!row) return false;
    if (row.state === 'open') { baseline = row.generation; return false; }
    capabilityState = await capability.probe();
    return true;
  }
  // Boot into a fence: nothing but the maintenance shell is served until the
  // restore is recovered and the control row is open again.
  async function initialize() {
    pendingStartup = true;
    work.closeAdmission();
    capabilityState ||= await capability.probe();
    if (!available()) {
      logger.error(`A portable restore left this instance in maintenance and this host cannot recover it (${capabilityState.message}). `
        + 'Stop the backend and run: node scripts/clear-portable-restore-fence.js --confirm');
      return;
    }
    await ensureRegistered({ running: false });
    startPolling();
    await tick();
  }
  async function waitForStartupAdmission({ timeoutMs } = {}) {
    const deadline = timeoutMs === undefined ? null : now() + timeoutMs;
    for (;;) {
      if (stopping) throw failure();
      if (deadline !== null && now() > deadline) {
        throw failure('An earlier restore is unfinished and could not be recovered in time; stop every backend process and try again', 'RESTORE_CONFLICT', 409);
      }
      let row = null;
      try { row = await read(); } catch (_) { /* Not readable yet: keep waiting. */ }
      if (row?.state === 'open' && (!initialized || row.generation === registration.generation)) {
        baseline = row.generation;
        pendingStartup = false; quiescence = null; acknowledged = null; servicesStopped = false;
        work.openAdmission();
        stopPolling();
        return;
      }
      if (initialized) await tick();
      if (stopping) throw failure();
      await new Promise(resolve => work.runUncontrolled(() => setTimeout(resolve, pollInterval)));
    }
  }
  // Normal boot, just before the listener opens: learn once whether this host
  // can run a coordinated restore and, if it can, start the marker watch.
  async function activate(runtimeHooks = {}) {
    Object.assign(hooks, Object.fromEntries(Object.entries(runtimeHooks).filter(([, value]) => typeof value === 'function')));
    if (activated) return capabilityState;
    activated = true;
    capabilityState ||= await capability.probe();
    if (!available()) {
      logger.info(`Portable restore (.picpeak import) is switched off on this host: ${capabilityState.message}. Everything else runs normally.`);
      return capabilityState;
    }
    startWatching();
    // Leftovers exist only where a restore ran before.
    void work.runUncontrolled(async () => {
      if (!(await fence.read())) return;
      const row = await control(() => db()(CONTROL).where({ id: 1 }).first());
      if (row) await cleanup.leftovers({ current: row.attempt_id, currentTerminal: row.state === 'open' });
    }).catch(error => logger.warn('Restore leftover cleanup failed', { error: error.message }));
    return capabilityState;
  }

  function status() {
    return { available: available(), reason: capabilityState?.reason || null, message: capabilityState?.message || null,
      maintenance: work.isClosed(), restartRequired: stale };
  }
  function admitRequest() {
    if (work.isClosed() || stale) throw failure();
  }
  async function reserveRestore({ archivePath, operatorId, options = {} }) {
    capabilityState ||= await capability.probe();
    if (!available()) throw failure(capabilityState.message, capabilityState.reason);
    if (stale || (!offline && (work.isClosed() || !Number.isSafeInteger(operatorId) || operatorId <= 0))) throw failure();
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !offline || key !== 'migrationStorageIndexPath')
      || (options.migrationStorageIndexPath !== undefined && (typeof options.migrationStorageIndexPath !== 'string'
        || !path.isAbsolute(options.migrationStorageIndexPath) || options.migrationStorageIndexPath.length > 2048))) {
      throw failure('Unsupported portable restore options', 'RESTORE_OPTIONS_INVALID', 400);
    }
    await ensureRegistered({ running: !offline });
    const handle = await ingressService().withIngress(async () => {
      const row = await read();
      if (row.state !== 'open' || registration.generation !== row.generation) throw failure('A coordinated restore is already active', 'RESTORE_CONFLICT', 409);
      const attemptId = crypto.randomUUID();
      const epoch = crypto.randomUUID();
      const progressToken = crypto.randomBytes(32).toString('hex');
      const lease = descriptor(await workerService().workerLeaseDescriptor({ attemptId }));
      const expected = path.join(location.maintenance, attemptId, 'worker.lease');
      if (lease.path !== expected) throw failure('Worker lease is outside its owned restore directory');
      const staged = path.join(path.dirname(expected), 'request.picpeak');
      const copied = await ingressService().copyArchive({ sourcePath: archivePath, destinationPath: staged });
      // The marker precedes the row: a runtime must be able to notice the
      // fence from storage alone. A marker without a fenced row is harmless.
      await fence.write({ fenced: true, generation: row.generation });
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
        try {
          const latest = await read();
          if (latest.archive_path === staged) copied.retain();
          else if (latest.state === 'open') await fence.write({ fenced: false, generation: latest.generation });
        } catch (_) { copied.retain(); }
        throw error;
      }
      // Closed from this moment, not from the first tick: no request may be
      // admitted between the reservation and the drain.
      work.closeAdmission();
      return { attemptId, progressToken, state: 'draining' };
    });
    // No ordinary HTTP owner contains this control request. Launching its
    // drain cannot wait for the same request/upload to finish its own response.
    startPolling();
    void tick();
    return handle;
  }
  async function start(args) {
    if (offline) throw failure('Offline authority is not an HTTP restore admission');
    return reserveRestore(args);
  }
  async function restoreOffline(args) {
    if (!offline) throw failure('Offline restore requires its private coordinator');
    try {
      capabilityState = await capability.probe();
      if (!available()) throw failure(`${capabilityState.message}. The offline restore needs the same host support as the import in the admin interface`, capabilityState.reason);
      await ensureRegistered({ running: false });
      // A previous restore that committed (or was interrupted) left the fence
      // up. With every other runtime gone this process is the new cohort:
      // recover or reopen it first, as a starting server would.
      if ((await read()).state !== 'open') {
        pendingStartup = true;
        work.closeAdmission();
        await waitForStartupAdmission({ timeoutMs: 120000 });
      }
      const handle = await reserveRestore(args);
      for (;;) {
        await tick();
        const row = await read();
        if (row.attempt_id !== handle.attemptId) throw failure('Offline restore attempt was superseded');
        const result = row.result_json ? parse(row.result_json) : {};
        if (row.state === 'open') {
          await stop();
          await work.drain();
          await lifetimeLease.release();
          const error = terminalError(result.error);
          throw error ? failure(error.message, error.code, error.statusCode) : failure('Restore failed; prior data was verified', 'RESTORE_ROLLED_BACK', 400);
        }
        if (row.state === 'restart_required' || (row.state === 'recovery_required' && !workerRunning)) {
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
          return { ...summary(result), restored: true, externalPathsConverted: true, externalPathError: null,
            outcome: result.outcome, restartRequired: true, attemptId: handle.attemptId };
        }
        if (stopping) throw failure();
        await new Promise(resolve => work.runUncontrolled(() => setTimeout(resolve, pollInterval)));
      }
    } catch (error) {
      await stop();
      await work.drain();
      if (initialized) await ingressService().drain();
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
    let row;
    try { row = await read(); } catch (_) { throw failure('Restore attempt not found', 'RESTORE_NOT_FOUND', 404); }
    let matches = false;
    if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) && /^[0-9a-f]{64}$/.test(row.progress_token_hash || '')) {
      matches = crypto.timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(row.progress_token_hash, 'hex'));
    }
    if (row.attempt_id !== attemptId || (!authenticatedSuperAdmin && !matches)) throw failure('Restore attempt not found', 'RESTORE_NOT_FOUND', 404);
    const result = row.result_json ? parse(row.result_json) : null;
    const failed = ['rolled_back', 'aborted', 'recovery_required'].includes(result?.outcome);
    return { attemptId, state: row.state, outcome: result?.outcome || null, summary: summary(result),
      // Why a restore did not go through; the instance itself is open again
      // after a rollback or an aborted drain.
      error: failed ? terminalError(result.error) : null,
      restartRequired: row.state === 'restart_required', complete: row.state === 'open' && !!result };
  }
  async function stop() {
    stopping = true;
    clearInterval(polling); polling = null;
    clearInterval(watching); watching = null;
    await activeWatch;
    await activeTick;
    // The runtime FD deliberately remains held until actual Node lifetime
    // ends. A hung/unknown worker must not be mistaken for a dead runtime.
  }
  return { activate, pendingAtBoot, initialize, waitForStartupAdmission, admitRequest, admitUpload: async () => admitRequest(),
    start, progress, tick, watch, stop, restoreOffline, validateStart,
    status,
    capability: async () => { capabilityState ||= await capability.probe(); return status(); },
    // Request tracking is only worth its cost where a restore can happen.
    tracking: () => available() || pendingStartup,
    isFenced: () => work.isClosed() || stale,
    isRegistered: () => initialized,
    instanceId: () => registration?.instance_id, isInitialized: () => initialized };
}

const coordinator = createCoordinator();
async function restoreOffline({ archivePath, currentAdminId, options = {} }) {
  if (coordinator.isInitialized()) throw failure('Offline restore is unavailable in an initialized server runtime');
  const offlineCoordinator = createCoordinator({ offline: true, work: applicationWork.createWorkRegistry(), stopServices: async () => {} });
  return offlineCoordinator.restoreOffline({ archivePath, operatorId: currentAdminId, options });
}
module.exports = { ...coordinator, restoreOffline, createCoordinator, HEARTBEAT_STALE_MS };
