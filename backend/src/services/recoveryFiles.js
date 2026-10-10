'use strict';

// Backup/recovery ownership is a deployment property, not an archive flag.
// CRM PDFs/signatures and static uploads still have direct filesystem writers;
// managed media, customer documents and transfer attachments use the adapter.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { getStorage } = require('./storage');
const { resolvePhotoStorageKey } = require('./photoResolver');
const logger = require('../utils/logger');

const MANAGED_ROOTS = [
  'events/active', 'events/archived', 'thumbnails', 'previews', 'heroes',
  'videos', 'watermarks', 'uploads/transfers', 'transfers',
  'business-docs/customer-documents',
];
const DEFAULT_MAX_BYTES = 5000 * 1024 * 1024;
// The list of required keys lives beside the database dump it belongs to; the
// run row only pins it with a count and a checksum.
const REFERENCES_SUFFIX = '.storage-references.json';
// Only the columns a storage reference is read from, fetched in id order.
const REFERENCE_COLUMNS = {
  events: ['id', 'is_archived', 'archive_path', 'source_mode'],
  photos: ['id', 'event_id', 'path', 'source_origin', 'thumbnail_path', 'preview_path', 'hero_path', 'watermark_path', 'web_path'],
  customer_documents: ['id', 'storage_key', 'purged_at'],
  transfer_uploads: ['id', 'stored_path'],
  transfer_extra_files: ['id', 'stored_path'],
};
const REFERENCE_BATCH = 1000;
const hasControl = value => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const badHeader = value => ['\r', '\n', '\0'].some(character => value.includes(character));

function validKey(key) {
  if (typeof key !== 'string' || !key || key.includes('\\') || hasControl(key)
      || /^[a-z]:/i.test(key) || key.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Invalid recovery storage key: ${String(key)}`);
  }
  return key;
}

const under = (key, root) => key === root || key.startsWith(`${root}/`);
function managedKey(key) {
  validKey(key);
  return MANAGED_ROOTS.some(root => under(key, root));
}

function remoteDestination(key) {
  return managedKey(key) && getStorage().kind() === 's3';
}

function objectOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery object metadata');
  const options = {};
  for (const field of ['contentType', 'contentDisposition', 'cacheControl']) {
    if (value[field] != null) {
      if (typeof value[field] !== 'string' || badHeader(value[field])) throw new Error(`Invalid recovery ${field}`);
      options[field] = value[field];
    }
  }
  if (value.metadata != null) {
    if (typeof value.metadata !== 'object' || Array.isArray(value.metadata)) throw new Error('Invalid recovery custom metadata');
    options.metadata = Object.fromEntries(Object.entries(value.metadata).map(([key, val]) => {
      if (!/^[a-z0-9_-]+$/i.test(key) || typeof val !== 'string' || badHeader(val)) {
        throw new Error('Invalid recovery custom metadata entry');
      }
      return [key, val];
    }));
  }
  return options;
}

function restoreObjectOptions(key, metadata) {
  const options = objectOptions(metadata);
  // These opaque attachment roots have the same mandatory delivery headers
  // on their normal writers, including legacy files with client extensions.
  if (under(key, 'uploads/transfers') || under(key, 'transfers')) {
    options.contentType = 'application/octet-stream';
    options.contentDisposition = 'attachment';
  }
  return options;
}

function selectedManifestFiles(manifest, options) {
  const entries = manifest.files?.manifest || [];
  if (options.restoreType !== 'selective') return entries;
  return options.selectedItems.filter(item => item.type === 'file').map(item => {
    const entry = entries.find(file => file.path === item.path);
    if (!entry) throw new Error(`Selected file is not in the backup catalogue: ${item.path}`);
    return entry;
  });
}

async function* rows(knex, table) {
  if (knex instanceof Map) { yield* knex.get(table) || []; return; }
  if (!await knex.schema.hasTable(table)) return;
  const info = await knex(table).columnInfo();
  const columns = REFERENCE_COLUMNS[table].filter(column => column in info);
  for (let last = null; ;) {
    const query = knex(table).select(columns).orderBy('id').limit(REFERENCE_BATCH);
    const batch = await (last === null ? query : query.where('id', '>', last));
    yield* batch;
    if (batch.length < REFERENCE_BATCH) return;
    last = batch[batch.length - 1].id;
  }
}

// Require the same selected keys even if ListObjects is partial or empty. A
// stale local copy cannot satisfy an S3 reference. Lifecycle deletion is not
// corruption: archived photos and purged customer documents have no live blob.
// Only originals, archives, documents and transfer files are required. A
// rendition can be regenerated, so a stale thumbnail row never fails a backup:
// its key is collected in `derived` (when given) and is otherwise optional.
async function requiredKeys(knex, selected, derived) {
  const keys = new Set();
  const add = (key, requiredRoot, label) => {
    if (!key && requiredRoot && selected(`${requiredRoot}/required`)) throw new Error(`${label} has no primary-storage key`);
    if (key) { validKey(key); if (selected(key) && managedKey(key)) keys.add(key); }
  };
  const addDerived = (key, photo) => {
    if (!key) return;
    try { validKey(key); } catch (error) {
      logger.warn(`Skipping malformed derived storage key on photo ${photo.id}: ${String(key)}`);
      return;
    }
    if (derived && selected(key) && managedKey(key)) derived.add(key);
  };
  const byId = new Map();
  for await (const event of rows(knex, 'events')) {
    byId.set(String(event.id), event);
    if (event.is_archived === true || event.is_archived === 1) {
      if (!event.archive_path && selected('events/archived/required.zip')) {
        throw new Error(`Archived event ${event.id} has no archive storage key`);
      }
      add(event.archive_path);
    }
  }
  for await (const photo of rows(knex, 'photos')) {
    const event = byId.get(String(photo.event_id));
    if (!event || event.is_archived === true || event.is_archived === 1) continue;
    const mode = photo.source_origin || event.source_mode || 'managed';
    if ((mode !== 'external' && mode !== 'reference' && selected('events/active/required.jpg')) || photo.path) {
      let key;
      try { key = resolvePhotoStorageKey(event, photo); } catch (error) {
        logger.warn(`Skipping photo ${photo.id} in the recovery inventory: ${error.message}`);
        continue;
      }
      add(key);
    }
    for (const field of ['thumbnail_path', 'preview_path', 'hero_path', 'watermark_path', 'web_path']) addDerived(photo[field], photo);
  }
  for await (const doc of rows(knex, 'customer_documents')) {
    if (!doc.purged_at) add(doc.storage_key, 'business-docs/customer-documents', `Customer document ${doc.id}`);
  }
  for (const table of ['transfer_uploads', 'transfer_extra_files']) {
    for await (const row of rows(knex, table)) add(row.stored_path,
      table === 'transfer_uploads' ? 'uploads/transfers' : 'transfers', `Transfer file ${row.id}`);
  }
  return keys;
}

async function adapterInventory(knex, roots, selected = key => roots.some(root => under(key, root)), requiredReferences = []) {
  const storage = getStorage();
  if (storage.kind() !== 's3') return [];
  roots.forEach(validKey);
  const queries = new Set();
  for (const root of roots) {
    for (const managed of MANAGED_ROOTS) {
      if (under(root, managed)) queries.add(root);
      else if (under(managed, root)) queries.add(managed);
    }
  }
  const found = new Map();
  for (const prefix of [...queries].filter(p => ![...queries].some(q => q !== p && under(p, q)))) {
    // A slash matters: "transfers/" must not capture "transfers-other".
    for (const entry of await storage.list(`${prefix}/`)) {
      if (typeof entry.key === 'string' && entry.key.endsWith('/') && Number(entry.size) === 0) {
        validKey(entry.key.slice(0, -1)); // Ignore only well-formed, empty directory markers.
        continue;
      }
      const key = validKey(entry.key);
      if (!under(key, prefix) || !managedKey(key) || !selected(key)) continue;
      found.set(key, { relativePath: key, size: entry.size, modified: entry.mtime, storage: 'adapter' });
    }
  }
  const derived = new Set();
  const required = await requiredKeys(knex, selected, derived);
  for (const key of requiredReferences) { validKey(key); if (selected(key) && managedKey(key)) required.add(key); }
  for (const key of required) {
    if (!found.has(key)) throw new Error(`Required primary-storage object is missing from the backup inventory: ${key}`);
  }
  for (const key of derived) {
    if (!found.has(key)) logger.debug(`Derived rendition is not in primary storage, left out of the inventory: ${key}`);
  }
  return [...found.values()];
}

// Capture and checksum exactly the bytes which will be published. The source
// can be a vetted descriptor or an adapter stream, never a reopened archive
// path. A private file also keeps stream lifetime independent of archiver.
async function captureStream(source, { maxBytes = DEFAULT_MAX_BYTES, expectedSize, checksum, label = 'recovery file' } = {}) {
  let staging;
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid recovery size limit');
    staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-recovery-file-'));
    const file = path.join(staging, 'content');
    await fsp.chmod(staging, 0o700);
    await pipeline(source, new Transform({ transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new Error(`${label} exceeds the recovery size limit`));
      hash.update(chunk);
      cb(null, chunk);
    } }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    if (expectedSize != null && (!Number.isSafeInteger(Number(expectedSize)) || Number(expectedSize) < 0 || size !== Number(expectedSize))) {
      throw new Error(`${label} size does not match the recorded object`);
    }
    const actual = hash.digest('hex');
    if (checksum && actual !== checksum) throw new Error(`${label} checksum verification failed`);
    return { path: file, size, checksum: actual, cleanup: () => fsp.rm(staging, { recursive: true, force: true }) };
  } catch (error) {
    source.destroy();
    if (staging) await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function captureAdapter(key, maxBytes = DEFAULT_MAX_BYTES) {
  validKey(key);
  const storage = getStorage();
  const stat = await storage.stat(key);
  if (!stat || !Number.isSafeInteger(Number(stat.size)) || Number(stat.size) < 0) throw new Error(`Primary-storage object is missing or has no valid size: ${key}`);
  if (Number(stat.size) > maxBytes) throw new Error(`Primary-storage object exceeds the backup size limit: ${key}`);
  const metadata = objectOptions(stat);
  const captured = await captureStream(await storage.get(key, { ifMatch: stat.etag, versionId: stat.versionId }), {
    maxBytes, expectedSize: stat.size, label: key,
  });
  try {
    const after = await storage.stat(key);
    const metadataValue = value => JSON.stringify(Object.entries(objectOptions(value)).map(([name, val]) =>
      [name, name === 'metadata' ? Object.entries(val).sort(([a], [b]) => a.localeCompare(b)) : val]));
    if (!after || after.etag !== stat.etag || after.versionId !== stat.versionId || after.size !== stat.size
        || metadataValue(after) !== metadataValue(stat)) throw new Error(`Primary-storage object changed during capture: ${key}`);
    return { ...captured, objectMetadata: metadata, modified: stat.mtime };
  } catch (error) { await captured.cleanup(); throw error; }
}

async function checksumAdapter(key, maxBytes = DEFAULT_MAX_BYTES) {
  const captured = await captureAdapter(key, maxBytes);
  try { return captured.checksum; } finally { await captured.cleanup(); }
}

async function verifyAdapter(key, checksum, metadata, maxBytes = DEFAULT_MAX_BYTES) {
  const captured = await captureAdapter(key, maxBytes);
  try {
    if (checksum && captured.checksum !== checksum) throw new Error(`Primary-storage checksum verification failed: ${key}`);
    for (const [name, expected] of Object.entries(objectOptions(metadata))) {
      const actual = captured.objectMetadata[name];
      const same = name === 'metadata'
        ? actual && Object.keys(actual).length === Object.keys(expected).length
          && Object.entries(expected).every(([k, v]) => actual[k] === v)
        : actual === expected;
      if (!same) throw new Error(`Primary-storage metadata verification failed: ${key} (${name})`);
    }
    return captured.checksum;
  } finally { await captured.cleanup(); }
}

// Materialize a catalogue for destinations that need a tree (rsync/export).
// Only the selected files are present; local decoys of managed keys are absent.
async function materialize(files, directory, maxBytes = DEFAULT_MAX_BYTES) {
  const output = [];
  const byKey = new Map();
  for (const original of files) {
    const key = validKey(original.relativePath || original.rel);
    const target = path.join(directory, ...key.split('/'));
    let captured;
    try {
      if (original.storage === 'adapter') captured = await captureAdapter(key, maxBytes);
      else {
        const source = original.path || original.abs;
        const handle = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          if (!(await handle.stat()).isFile()) throw new Error(`Not a regular recovery source: ${key}`);
          captured = await captureStream(handle.createReadStream(), { maxBytes, label: key });
        } finally { await handle.close().catch(() => {}); }
      }
      const existing = byKey.get(key);
      if (existing) {
        if (existing.checksum !== captured.checksum || existing.size !== captured.size
            || existing.storage !== original.storage) throw new Error(`Conflicting recovery sources for ${key}`);
        existing.legacyValues = [...new Set([...(existing.legacyValues || []), ...(original.legacyValues || [])])];
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(captured.path, target);
      const entry = { ...original, path: target, abs: target, rel: key, relativePath: key, recoveryCaptured: true,
        checksum: captured.checksum, size: captured.size,
        objectMetadata: captured.objectMetadata || original.objectMetadata, modified: captured.modified || original.modified };
      output.push(entry); byKey.set(key, entry);
    } finally { if (captured) await captured.cleanup(); }
  }
  return output;
}

module.exports = { MANAGED_ROOTS, DEFAULT_MAX_BYTES, REFERENCES_SUFFIX, validKey, managedKey, remoteDestination, objectOptions,
  restoreObjectOptions, selectedManifestFiles, adapterInventory, requiredKeys, captureStream, captureAdapter, checksumAdapter, verifyAdapter, materialize };
