'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { acquireRestoreDatabaseLock } = require('./portableRestoreDatabaseLock');
const applicationWork = require('./activeApplicationWork');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REQUEST = 32768;
const MAX_METADATA = 256 * 1024 * 1024;
const MAX_RESULT = 16384;
const MiB = 1024 * 1024;
const context = new AsyncLocalStorage();
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const unsafe = message => Object.assign(new Error(message), { code: 'RESTORE_WORKER_UNSAFE', statusCode: 503 });
const paths = () => require('./portableRestorePaths');
const leases = () => require('./linuxKernelLease');
const database = () => require('../database/db').db;

function validateMetadataLimit(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_METADATA) throw unsafe('Invalid private restore metadata bound');
}

async function readOwnedJson(file, maximum = MAX_REQUEST) {
  validateMetadataLimit(maximum);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)
        || !Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maximum) throw unsafe('Invalid private restore metadata');
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (!read.bytesRead) throw unsafe('Private restore metadata was truncated');
      position += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw unsafe('Private restore metadata changed');
    return JSON.parse(decoder.decode(bytes));
  } finally { await handle.close(); }
}

async function writeOwnedJson(file, value, maximum = MAX_REQUEST) {
  validateMetadataLimit(maximum);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maximum) throw unsafe('Private restore metadata exceeds its bound');
  const temporary = `${file}.${crypto.randomUUID()}.next`;
  const handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temporary, file);
  await paths().syncDirectory(path.dirname(file));
  return digest(encoded);
}

async function workerLeaseDescriptor({ attemptId }) {
  if (!UUID.test(attemptId)) throw unsafe('Invalid restore attempt');
  const directory = await paths().attemptDirectory(attemptId, { create: true });
  const lease = await leases().acquire(path.join(directory, 'worker.lease'));
  try {
    await paths().syncDirectory(directory);
    return { path: lease.path, device: lease.device, inode: lease.inode, filesystem: lease.filesystem };
  } finally { await lease.release(); }
}

async function probeWorkerLease(descriptor) {
  try {
    const attemptId = path.basename(path.dirname(descriptor.path));
    if (!UUID.test(attemptId)) return 'unknown';
    const directory = await paths().attemptDirectory(attemptId);
    if (descriptor.path !== path.join(directory, 'worker.lease')) return 'unknown';
    return await leases().probe(descriptor.path, descriptor);
  } catch (_) { return 'unknown'; }
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'migrationStorageIndexPath')) throw unsafe('Unsupported restore options');
  if (options.migrationStorageIndexPath !== undefined && (typeof options.migrationStorageIndexPath !== 'string'
      || !path.isAbsolute(options.migrationStorageIndexPath) || options.migrationStorageIndexPath.length > 2048)) throw unsafe('Invalid private migration sidecar path');
}

async function persistedRequest(args) {
  if (!UUID.test(args.attemptId) || !UUID.test(args.epoch)) throw unsafe('Invalid restore identity');
  const directory = await paths().attemptDirectory(args.attemptId);
  const row = await applicationWork.runControl(() => database()('portable_restore_control')
    .where({ id: 1, attempt_id: args.attemptId, epoch: args.epoch, state: 'restoring' }).first());
  if (!row || typeof row.options_json !== 'string' || Buffer.byteLength(row.options_json) > MAX_REQUEST) throw unsafe('Restore control is not fenced');
  const options = JSON.parse(row.options_json);
  validateOptions(options);
  const descriptor = JSON.parse(row.worker_lease_json);
  if (descriptor.path !== path.join(directory, 'worker.lease')
      || ['path', 'device', 'inode', 'filesystem'].some(key => descriptor[key] !== args.workerLeaseDescriptor[key])) throw unsafe('Restore lease identity changed');
  const request = { version: 1, attemptId: args.attemptId, epoch: args.epoch,
    archivePath: path.join(directory, 'request.picpeak'), operatorId: row.operator_id,
    optionsJson: row.options_json, optionsDigest: digest(row.options_json), workerLeaseDescriptor: descriptor };
  const requestPath = path.join(directory, 'request.json');
  try {
    const existing = await readOwnedJson(requestPath);
    if (JSON.stringify(existing) !== JSON.stringify(request)) throw unsafe('Restore request belongs to another epoch');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeOwnedJson(requestPath, request);
  }
  return { directory, requestPath, descriptor };
}

// Budgets follow the archive: a restore of a large library must not run into
// a limit sized for a small one and fall back into a rollback. `census` is
// { entries, expandedBytes, largestBytes } of the staged archive. Environment
// values, where set, win. There is no CPU-time limit unless one is configured;
// the wall-clock deadline bounds the worker.
function workerConfiguration(census = {}) {
  const entries = Number.isSafeInteger(census.entries) ? census.entries : 0;
  const expanded = Number.isSafeInteger(census.expandedBytes) ? census.expandedBytes : 0;
  const largest = Number.isSafeInteger(census.largestBytes) ? census.largestBytes : 0;
  const bounded = (name, fallback, maximum, minimum = 1) => {
    const value = process.env[name] === undefined || process.env[name] === '' ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw unsafe(`Invalid ${name}`);
    return value;
  };
  // The archive directory and the file catalogue live in memory: about 2 KiB
  // per entry on top of the base.
  const memory = bounded('PICPEAK_IMPORT_WORKER_MEMORY_MIB', Math.min(8192, 768 + Math.ceil(entries / 500)), 65536);
  if (memory < 256) throw unsafe('Restore worker memory is below its supported minimum');
  // Extract, hash and stage at a conservative 4 MiB/s, plus 20 ms per entry.
  const wall = 30 * 60 * 1000 + Math.ceil(expanded / (4 * MiB)) * 1000 + entries * 20;
  return { memoryBytes: memory * MiB, heap: Math.floor(memory * 0.6),
    wallMs: bounded('PICPEAK_IMPORT_WORKER_TIMEOUT_MS', Math.min(wall, 7 * 24 * 60 * 60 * 1000), 7 * 24 * 60 * 60 * 1000),
    cpuSeconds: bounded('PICPEAK_IMPORT_WORKER_CPU_SECONDS', 0, 2592000, 0),
    fileBytes: Math.min(1024 * 1024 * MiB, Math.max(10 * 1024 * MiB, largest + 1024 * MiB)) };
}

async function archiveCensus(archivePath) {
  // Central directory only. A staged archive that cannot be read keeps the
  // base budget; the worker itself reports why it is unreadable.
  try {
    const archive = require('./portableImportArchive');
    const zip = await archive.openBoundedArchive(archivePath, { validateFileKey: () => null });
    try { return archive.archiveCensus(Object.values(await zip.entries()), { validateFileKey: () => null }); }
    finally { await zip.close(); }
  } catch (_) { return {}; }
}

async function launch(args, mode) {
  if (process.platform !== 'linux') throw unsafe('Coordinated portable restore requires Linux');
  if (await probeWorkerLease(args.workerLeaseDescriptor) !== 'free') throw unsafe('Previous restore worker is not proven terminal');
  const { directory, requestPath, descriptor } = await persistedRequest(args);
  const policy = workerConfiguration(await archiveCensus(path.join(directory, 'request.picpeak')));
  const runner = require('./nativeProcessRunner');
  // Ordinary native queues have been stopped and drained by every runtime.
  // Reopen only this hard-limited runner while ordinary application admission
  // stays closed. No service scheduler is restarted here.
  runner.start();
  const result = await runner.run(process.execPath, ['--jitless', `--max-old-space-size=${policy.heap}`,
    path.join(__dirname, '../workers/portableRestoreWorker.js'), mode, requestPath], {
    prefix: 'PICPEAK_IMPORT', lane: 'long', memoryBytes: policy.memoryBytes, wallMs: policy.wallMs,
    cpuSeconds: policy.cpuSeconds, fileBytes: policy.fileBytes,
    outputBytes: MiB, leasePath: descriptor.path,
    env: { NODE_OPTIONS: '', TMPDIR: path.join(path.dirname(requestPath), 'workspace') },
    onStart: async actual => {
      if (['device', 'inode', 'filesystem'].some(key => actual[key] !== descriptor[key])) throw unsafe('Native restore inherited a different lease');
      if (typeof args.onStart !== 'function') throw unsafe('Restore worker requires explicit epoch admission');
      await args.onStart(actual);
    },
  });
  if (await probeWorkerLease(descriptor) !== 'free') throw unsafe('Restore worker termination is not proven');
  const line = result.stdout.toString('utf8').split('\n').filter(value => value.startsWith('PICPEAK_RESTORE_RESULT=')).pop();
  if (!line || Buffer.byteLength(line) > MAX_RESULT) throw unsafe('Restore worker returned no bounded terminal result');
  const value = JSON.parse(line.slice('PICPEAK_RESTORE_RESULT='.length));
  if (value.version !== 1 || value.attemptId !== args.attemptId
      || !['committed', 'rolled_back', 'recovery_required'].includes(value.outcome)) throw unsafe('Restore worker terminal result is invalid');
  return { ...value, proof: 'kernel_lease_released' };
}

async function assertWorkerAuthority(executor) {
  const request = context.getStore();
  if (!request) throw unsafe('Portable mutation requires the supervised maintenance worker');
  const inherited = fs.fstatSync(9, { bigint: true });
  if (!inherited.isFile() || inherited.nlink !== 1n || inherited.uid !== BigInt(process.getuid())
      || String(inherited.dev) !== request.workerLeaseDescriptor.device
      || String(inherited.ino) !== request.workerLeaseDescriptor.inode) throw unsafe('Restore lifetime lease is not inherited');
  const row = await (executor || database())('portable_restore_control')
    .where({ id: 1, attempt_id: request.attemptId, epoch: request.epoch, state: 'restoring' }).first();
  if (!row || row.options_json !== request.optionsJson) throw unsafe('Portable worker authority was superseded');
  return request;
}

async function runWorkerProcess(mode, requestPath) {
  if (process.platform !== 'linux' || !['import', 'recover'].includes(mode)) throw unsafe('Invalid portable worker mode');
  const request = await readOwnedJson(requestPath);
  if (request.version !== 1 || !UUID.test(request.attemptId) || !UUID.test(request.epoch)
      || typeof request.optionsJson !== 'string' || digest(request.optionsJson) !== request.optionsDigest) throw unsafe('Invalid restore request');
  validateOptions(JSON.parse(request.optionsJson));
  const directory = await paths().attemptDirectory(request.attemptId);
  if (requestPath !== path.join(directory, 'request.json') || request.archivePath !== path.join(directory, 'request.picpeak')) throw unsafe('Restore request path is redirected');
  return context.run(request, async () => {
    await assertWorkerAuthority();
    const workspace = path.join(directory, 'workspace');
    await fsp.mkdir(workspace, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fsp.lstat(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
        || await fsp.realpath(workspace) !== workspace) throw unsafe('Restore workspace is unsafe');
    const importer = require('./picpeakImportService');
    let result;
    if (mode === 'recover') result = await importer.recoverInMaintenanceWorker();
    else {
      try { result = await importer.importInMaintenanceWorker(); }
      catch (error) {
        // No client-side guess about COMMIT. Recovery reacquires the database
        // transaction lock before it reads the marker or changes any file.
        result = await importer.recoverInMaintenanceWorker();
        if (result.outcome === 'rolled_back') result.error = {
          code: /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'PICPEAK_IMPORT_FAILED',
          statusCode: [400, 403, 409, 413, 422, 507].includes(error.statusCode) ? error.statusCode : 500,
          message: String(error.message || 'Portable restore failed').slice(0, 512),
        };
      }
    }
    return { version: 1, attemptId: request.attemptId, ...result };
  });
}

module.exports = { workerLeaseDescriptor, probeWorkerLease,
  startWorker: args => launch(args, 'import'), recoverWorker: args => launch(args, 'recover'),
  assertWorkerAuthority, runWorkerProcess, acquireRestoreDatabaseLock,
  readOwnedJson, writeOwnedJson, workerConfiguration, digest };
