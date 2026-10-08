'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { db } = require('../database/db');
const { getStoragePath } = require('../config/storage');
const { getStorage, initStorage } = require('./storage');
const { PortableRestoreJournal, MAX_FILES } = require('./portableRestoreJournal');
const { rowBatches } = require('./portableImportRows');
const worker = require('./portableRestoreWorker');
const { acquireRestoreTableLocks } = require('./portableRestoreDatabaseLock');
const recoveryFiles = require('./recoveryFiles');
const generationIndex = require('./storage/generationIndex');
const { formatBoolean } = require('../utils/dbCompat');
const { nextSessionCutoff, setSessionsValidAfter, waitPastSessionCutoff } = require('../utils/sessionCutoff');
const logger = require('../utils/logger');

const RUNTIME_TABLES = new Set(require('../utils/restoreRuntimeTables'));
const SHA256 = /^[a-f0-9]{64}$/;
const helpers = () => require('./picpeakImportService');
const archive = () => require('./portableImportArchive');
const journalPaths = () => require('./portableRestorePaths');

async function withMaintenanceDatabaseAuthority(run) {
  // Authority is established BEFORE considering compatibility with the
  // separately introduced CRM policy. Missing request/worker authority never
  // becomes a system actor. An immutable older build simply has no CRM layer.
  await worker.assertWorkerAuthority();
  const policyFile = path.join(__dirname, '../database/crmAccess.js');
  if (!fs.existsSync(policyFile)) return run();
  const { withTrustedCrmAccess } = require(policyFile);
  if (typeof withTrustedCrmAccess !== 'function') throw new Error('Maintenance CRM capability is unavailable');
  return withTrustedCrmAccess('supervised coordinated maintenance restore', run);
}

async function hashFile(file, expectedSize, expectedChecksum) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)
        || stat.size < 0 || stat.size > 5 * 1024 ** 3 || (expectedSize !== undefined && stat.size !== expectedSize)) throw new Error('Invalid portable source file size');
    let size = 0;
    const hash = crypto.createHash('sha256');
    // This handle is the sole FD owner, including pipeline/iterator cancellation.
    const input = fs.createReadStream(file, { fd: handle.fd, autoClose: false, highWaterMark: 65536,
      fs: { read: fs.read.bind(fs), close: (_fd, callback) => callback() } });
    for await (const chunk of input) {
      size += chunk.length;
      if (size > stat.size) throw new Error('Portable source grew during verification');
      hash.update(chunk);
    }
    const after = await handle.stat();
    const checksum = hash.digest('hex');
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || (expectedChecksum !== undefined && checksum !== expectedChecksum)) throw new Error('Portable source checksum changed');
    return { size, checksum };
  } finally { await handle.close(); }
}

async function verifyRemoteFile(storage, file) {
  const stat = await storage.stat(file.logical);
  if (!stat || Number(stat.size) !== file.size) throw new Error('Staged primary object size does not match');
  const expectedMetadata = recoveryFiles.objectOptions(file.object_metadata);
  const actualMetadata = recoveryFiles.objectOptions(stat);
  for (const [key, value] of Object.entries(expectedMetadata)) {
    const actual = actualMetadata[key];
    const same = key === 'metadata' ? actual && Object.keys(actual).length === Object.keys(value).length
      && Object.entries(value).every(([name, expected]) => actual[name] === expected) : actual === value;
    if (!same) throw new Error('Staged primary object metadata does not match');
  }
  const input = await storage.get(file.logical, { ifMatch: stat.etag, versionId: stat.versionId });
  let size = 0;
  const hash = crypto.createHash('sha256');
  try {
    for await (const bytes of input) {
      size += bytes.length;
      if (size > file.size) throw new Error('Staged primary object exceeds its size');
      hash.update(bytes);
    }
    const after = await storage.stat(file.logical);
    if (size !== file.size || hash.digest('hex') !== file.checksum || !after
        || after.etag !== stat.etag || after.versionId !== stat.versionId || after.size !== stat.size) throw new Error('Staged primary object checksum changed');
  } finally { input.destroy(); }
}

function catalogue(manifest) {
  const result = new Map();
  if (manifest.files === undefined || manifest.files === null) return result;
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw new Error('Invalid portable file catalogue');
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object') throw new Error('Invalid portable file catalogue entry');
    const key = recoveryFiles.validKey(file.path);
    if (result.has(key) || helpers().importFilePathProblem(key) || !Number.isSafeInteger(file.size)
        || file.size < 0 || file.size > 5 * 1024 ** 3 || typeof file.checksum !== 'string'
        || !SHA256.test(file.checksum)) throw new Error('Invalid portable file size/checksum');
    recoveryFiles.objectOptions(file.object_metadata);
    result.set(key, file);
  }
  return result;
}

async function preflightRows(tables, dataDir, crossEngine) {
  for (const table of tables) {
    const known = new Set(Object.keys(await db(table).columnInfo()));
    const json = await helpers().jsonColumnsFor(db, table);
    const types = crossEngine ? await helpers().typedColumnsFor(db, table) : null;
    for await (const batch of rowBatches(path.join(dataDir, table + '.ndjson'), { allowMissing: true })) {
      if (batch.some(row => Object.keys(row).some(column => !known.has(column)))) throw new Error('Portable table contains an unknown target column');
      let prepared = crossEngine ? helpers().coerceForTargetEngine(batch, types) : batch;
      prepared = helpers().serialiseJsonColumns(prepared, crossEngine ? new Set() : json);
      prepared = helpers().relocateStoredPaths(table, prepared, path.join(path.dirname(dataDir), 'files'));
      helpers().assertContainedPaths(table, prepared);
    }
  }
}

async function resetDerivedQueues(trx) {
  const optional = path.join(__dirname, 'mediaAttemptService.js');
  if (fs.existsSync(optional)) {
    const { resetImportedMediaAttempts } = require(optional);
    if (typeof resetImportedMediaAttempts !== 'function') throw new Error('Media restore admission reset is unavailable');
    await resetImportedMediaAttempts(trx);
  }
  if (await trx.schema.hasColumn('photos', 'face_status') && await trx.schema.hasColumn('events', 'face_recognition_enabled')) {
    await trx('photos').whereIn('event_id', trx('events').select('id')
      .where('face_recognition_enabled', formatBoolean(true))).update({
      face_status: 'pending', face_count: null, face_started_at: null, face_error: null,
    });
  }
}

async function requiredRepairs() {
  // setval is nontransactional. Do not alter it before the matching commit:
  // a failed load must leave prior sequences intact. Any repair failure keeps
  // the new committed version fenced for retry; it is never reported rolled back.
  const tables = (await require('./picpeakExportService').listDataTables()).filter(table => !RUNTIME_TABLES.has(table));
  await helpers().resyncSequences(tables, { strict: true });
  require('./contract/defaultTemplate').forgetEnsured();
  await require('./pdf/uploadedFonts').migrateLegacyFont(logger);
}

async function importInMaintenanceWorker() {
  return withMaintenanceDatabaseAuthority(async () => {
    const request = await worker.assertWorkerAuthority();
    const directory = await journalPaths().attemptDirectory(request.attemptId);
    const staging = await fsp.mkdtemp(path.join(directory, 'workspace', 'extracted-'));
    await fsp.chmod(staging, 0o700);
    const manifest = await helpers().readManifestFromZip(request.archivePath);
    const blockers = await helpers().validateManifest(manifest);
    if (blockers.length) throw Object.assign(new Error(blockers[0]), { statusCode: 400 });
    const pg = ['pg', 'postgres', 'postgresql'].includes(db.client.config.client);
    const targetEngine = pg ? 'pg' : 'sqlite';
    const crossEngine = ((manifest.database && manifest.database.engine) || targetEngine) !== targetEngine;
    const allTables = (await require('./picpeakExportService').listDataTables()).filter(table => !RUNTIME_TABLES.has(table));
    const tableSet = new Set(allTables);
    const tables = Object.keys(manifest.tables || {}).filter(table => tableSet.has(table));
    const zip = await archive().openBoundedArchive(request.archivePath, { validateFileKey: helpers().importFilePathProblem, allowedTables: tableSet });
    let entries;
    try {
      entries = Object.values(await zip.entries());
      await archive().assertArchiveWithinLimits(entries, staging, { validateFileKey: helpers().importFilePathProblem, allowedTables: tableSet, persistentRoot: getStoragePath() });
      await archive().extractWithinLimits(zip, entries, staging, { persistentRoot: getStoragePath() });
    } finally { await zip.close(); }
    const recorded = catalogue(manifest);
    const files = entries.filter(entry => !entry.isDirectory && entry.name.startsWith('files/')).map(entry => entry.name.slice(6));
    if (files.length > MAX_FILES) throw new Error('Portable restore exceeds its file budget');
    const present = new Set(files);
    for (const key of recorded.keys()) if (!present.has(key)) throw new Error('Portable file catalogue references a missing file');
    for (const key of files) {
      const known = recorded.get(key);
      const evidence = await hashFile(path.join(staging, 'files', ...key.split('/')), known?.size, known?.checksum);
      if (!known) recorded.set(key, { path: key, ...evidence });
    }
    await preflightRows(tables, path.join(staging, 'data'), crossEngine);
    await initStorage();
    const storage = getStorage();
    const remote = files.filter(key => recoveryFiles.remoteDestination(key));
    const local = files.filter(key => !recoveryFiles.remoteDestination(key));
    await fsp.mkdir(path.join(staging, 'files'), { recursive: true, mode: 0o700 });
    const journal = await PortableRestoreJournal.create({ storageRoot: getStoragePath(), id: request.attemptId,
      validateKey: helpers().importFilePathProblem, reuseWorkerDirectory: true });
    await journal.prepare(path.join(staging, 'files'), local);
    let generation;
    let s3Manifest;
    if (remote.length) {
      generation = storage.createRestoreGeneration(request.attemptId, remote);
      for (const key of remote) {
        const file = recorded.get(key);
        const options = recoveryFiles.restoreObjectOptions(key, file.object_metadata);
        await generation.storage.putFromFile(key, path.join(staging, 'files', ...key.split('/')), options);
        await verifyRemoteFile(generation.storage, { logical: key, ...file, object_metadata: options });
        generation.recordVerified(key, { size: file.size, checksum: file.checksum, object_metadata: options });
      }
      s3Manifest = generation.manifest();
    }
    const options = JSON.parse(request.optionsJson);
    let migrationRows;
    if (options.migrationStorageIndexPath) {
      migrationRows = await generationIndex.readMigrationIndex(options.migrationStorageIndexPath, storage.namespace);
      if (migrationRows.length && storage.kind() !== 's3') throw new Error('S3 migration index does not match the target backend');
      if (remote.length) throw new Error('Same-install engine migration must not import object files');
      if (migrationRows.length) s3Manifest = { version: 1, id: request.attemptId, namespace: storage.namespace,
        baseRevision: storage.revision, revision: migrationRows[0].revision, files: [], writes: [] };
    }
    const s3Checksum = s3Manifest ? await worker.writeOwnedJson(path.join(directory, 's3.json'), s3Manifest, generationIndex.MAX_ENCODED_BYTES) : null;
    const cutoff = nextSessionCutoff();
    const summary = { tables: tables.length, filesRestored: files.length, crossEngine,
      usesExternalMedia: await helpers().detectExternalMedia(), sessionInvalidated: true };
    await worker.writeOwnedJson(path.join(directory, 'summary.json'), summary);
    await db.transaction(async trx => {
      await worker.acquireRestoreDatabaseLock(trx, request);
      await worker.assertWorkerAuthority(trx);
      await acquireRestoreTableLocks(trx);
      // Preserve the latest terminal operator credentials/grants, not a
      // snapshot taken while an ordinary remote COMMIT could still finish.
      const currentAdmin = request.operatorId ? await trx('admin_users').where({ id: request.operatorId }).first() : null;
      if (request.operatorId && !currentAdmin) throw new Error('Restore operator is no longer available');
      const role = currentAdmin ? await helpers().captureOperatorRole(currentAdmin.role_id, trx) : null;
      await helpers().replaceAllTables(tables, path.join(staging, 'data'), currentAdmin, role,
        { executor: trx, crossEngine, allTables });
      await require('./externalRelpathFold').foldExternalRelpaths(trx, message => logger.info('Portable restore external path conversion', { message }));
      await resetDerivedQueues(trx);
      await setSessionsValidAfter(cutoff, { executor: trx, refreshCache: false });
      if (generation) await generation.publish(trx);
      if (migrationRows) {
        await trx(generationIndex.TABLE).del();
        if (migrationRows.length) await trx(generationIndex.TABLE).insert(migrationRows);
      }
      await journal.promote(path.join(staging, 'files'));
      await journal.verifyCommitted();
      await trx('portable_restore_commits').insert({ attempt_id: request.attemptId, format_version: 1,
        local_plan_checksum: journal.state.planChecksum, s3_namespace: s3Manifest?.namespace || null,
        s3_revision: s3Manifest?.revision || null, s3_manifest_checksum: s3Checksum,
        options_digest: request.optionsDigest });
    }, pg ? { isolationLevel: 'read committed' } : undefined);
    await waitPastSessionCutoff(cutoff);
    // The same lock-based recovery path verifies every committed representation
    // and completes mandatory postcommit repairs before reporting success.
    return recoverInMaintenanceWorker();
  });
}

async function recoverInMaintenanceWorker() {
  return withMaintenanceDatabaseAuthority(async () => {
    const request = await worker.assertWorkerAuthority();
    const directory = await journalPaths().attemptDirectory(request.attemptId);
    let marker;
    let journal;
    const pg = ['pg', 'postgres', 'postgresql'].includes(db.client.config.client);
    await db.transaction(async trx => {
      await worker.acquireRestoreDatabaseLock(trx, request);
      await worker.assertWorkerAuthority(trx);
      await acquireRestoreTableLocks(trx);
      marker = await trx('portable_restore_commits').where({ attempt_id: request.attemptId }).first();
      try {
        journal = await PortableRestoreJournal.load({ storageRoot: getStoragePath(), id: request.attemptId, validateKey: helpers().importFilePathProblem });
      } catch (error) {
        if (error.code !== 'ENOENT' || marker) throw error;
        // No complete prepared journal means promotion could not have begun.
        // Never interpret a partially removed prepared journal as this case.
        const state = await fsp.lstat(path.join(directory, 'state.json')).catch(missing => { if (missing.code !== 'ENOENT') throw missing; return null; });
        const plan = await fsp.lstat(path.join(directory, 'plan.ndjson')).catch(missing => { if (missing.code !== 'ENOENT') throw missing; return null; });
        if (state || plan) throw new Error('Restore journal staging evidence is missing');
      }
      if (!marker) { if (journal) await journal.rollback(); return; }
      if (!journal || marker.format_version !== 1 || marker.options_digest !== request.optionsDigest
          || marker.local_plan_checksum !== journal.state.planChecksum) throw new Error('Matching restore commit marker is invalid');
      await journal.verifyCommitted();
    }, pg ? { isolationLevel: 'read committed' } : undefined);
    if (!marker) return { outcome: 'rolled_back', summary: {} };
    const hasS3 = marker.s3_manifest_checksum !== null || marker.s3_namespace !== null || marker.s3_revision !== null;
    if (hasS3) {
      const manifest = await worker.readOwnedJson(path.join(directory, 's3.json'), generationIndex.MAX_ENCODED_BYTES);
      if (worker.digest(JSON.stringify(manifest)) !== marker.s3_manifest_checksum || manifest.version !== 1
          || manifest.id !== request.attemptId || manifest.namespace !== marker.s3_namespace
          || manifest.revision !== marker.s3_revision || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw new Error('Committed S3 restore manifest does not match');
      const storage = await initStorage();
      if (storage.kind() !== 's3' || storage.namespace !== manifest.namespace || storage.revision !== manifest.revision) throw new Error('Committed primary representation is not active');
      const seen = new Set();
      for (const file of manifest.files) {
        if (!file || seen.has(file.logical) || storage.mapping.get(file.logical) !== file.physical) throw new Error('Committed S3 mapping does not match');
        seen.add(file.logical);
        await verifyRemoteFile(storage, file);
      }
    }
    await requiredRepairs();
    const summary = await worker.readOwnedJson(path.join(directory, 'summary.json'));
    return { outcome: 'committed', summary: { ...summary, usesExternalMedia: await helpers().detectExternalMedia() } };
  });
}

module.exports = { importInMaintenanceWorker, recoverInMaintenanceWorker };
