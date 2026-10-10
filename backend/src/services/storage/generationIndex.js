'use strict';

const crypto = require('crypto');
const fs = require('fs');
const migration = require('../../../migrations/core/283_storage_s3_generation_index');
const TABLE = 'storage_s3_generation_index';
const INTERNAL_ROOT = '.picpeak-generations';
// The index holds one entry per object a restore put under a generation key.
// A later restore of the same object replaces its entry, so the index is as
// large as the set of distinct restored objects: it has to admit what the
// import limits admit, or an earlier restore would make a later one impossible.
const maxEntries = () => require('../portableImportArchive').limits().entries;
const MAX_ENCODED_BYTES = 256 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ATTEMPT = /^[a-zA-Z0-9_-]{8,128}$/;
const PHYSICAL = /^\.picpeak-generations\/[a-zA-Z0-9_-]{8,128}\/[a-f0-9-]{36}$/;

function logicalKey(value, { prefix = '', listing = false } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\\')
      || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || /^[a-z]:/i.test(value)) throw new Error('Invalid S3 storage key');
  const key = listing && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!key || key.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('S3 storage key path traversal or invalid segment');
  }
  if (key.split('/')[0] === INTERNAL_ROOT) throw new Error('Reserved S3 generation namespace');
  if (Buffer.byteLength(prefix ? `${prefix}/${value}` : value) > 1024) throw new Error('S3 storage key exceeds 1024 bytes');
  return value;
}

function validateRows(rows, namespace, prefix = '') {
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid S3 generation index row count');
  if (!rows.length) return { revision: null, mapping: new Map() };
  const row = rows[0];
  if (row.id !== 1 || !/^[a-f0-9]{64}$/.test(row.namespace) || !UUID.test(row.revision)
      || (namespace && row.namespace !== namespace)) throw new Error('Invalid or foreign S3 generation index identity');
  if (typeof row.mapping !== 'string' || Buffer.byteLength(row.mapping) > MAX_ENCODED_BYTES) {
    throw new Error('Invalid or oversized S3 generation index');
  }
  let parsed;
  try { parsed = JSON.parse(row.mapping); } catch (_) { throw new Error('Corrupt S3 generation index'); }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > maxEntries()) {
    throw new Error('Invalid S3 generation index format or cardinality');
  }
  const mapping = new Map();
  const physicalKeys = new Set();
  for (const entry of parsed.entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid S3 generation index entry');
    const [logical, physical] = entry;
    logicalKey(logical, { prefix });
    if (typeof physical !== 'string' || !PHYSICAL.test(physical) || !UUID.test(physical.split('/')[2])
        || Buffer.byteLength(prefix ? `${prefix}/${physical}` : physical) > 1024
        || mapping.has(logical) || physicalKeys.has(physical)) throw new Error('Invalid S3 generation physical key');
    mapping.set(logical, physical);
    physicalKeys.add(physical);
  }
  return { revision: row.revision, mapping };
}

function encodeRows(namespace, mapping, revision = crypto.randomUUID()) {
  if (mapping.size > maxEntries()) throw new Error('S3 generation index exceeds its entry limit');
  let bytes = 64;
  for (const entry of mapping) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > MAX_ENCODED_BYTES) throw new Error('S3 generation index exceeds its byte limit');
  }
  const rows = [{ id: 1, namespace, revision,
    mapping: JSON.stringify({ version: 1, entries: [...mapping].sort(([a], [b]) => a.localeCompare(b)) }) }];
  validateRows(rows, namespace);
  return rows;
}

async function readRows(knex, { requireTable = true } = {}) {
  if (!(await knex.schema.hasTable(TABLE))) {
    if (!requireTable) return [];
    throw new Error('S3 generation index unavailable; run migrations before starting storage');
  }
  // Check size without first fetching an arbitrarily large text value. The
  // JSON encoding is predominantly ASCII; UTF-8 bytes are checked below too.
  const sizes = await knex(TABLE).select('id').select(knex.raw('length(mapping) as mapping_length')).limit(2);
  if (sizes.length > 1 || sizes.some(row => Number(row.mapping_length) > MAX_ENCODED_BYTES)) {
    throw new Error('Oversized S3 generation index');
  }
  const rows = await knex(TABLE).select('*').limit(2);
  validateRows(rows);
  return rows;
}

// Full native DB restore must keep the TARGET representation, not the
// source's runtime index. Capture before pool teardown; replay after reinit.
async function snapshotDatabaseIndex(knex) {
  return readRows(knex, { requireTable: false });
}

async function restoreDatabaseIndex(knex, rows) {
  validateRows(rows);
  await knex.transaction(async trx => {
    await migration.up(trx); // Old captures may have no runtime schema.
    await trx(TABLE).del();
    if (rows.length) await trx(TABLE).insert(rows);
  });
}

// The SAME-INSTALL engine-migration CLI uses a private sidecar, not portable
// archive data. An ordinary uploaded .picpeak can never supply this channel.
async function writeMigrationIndex(file, knex) {
  const rows = await snapshotDatabaseIndex(knex);
  const encoded = JSON.stringify(rows);
  if (Buffer.byteLength(encoded) > MAX_ENCODED_BYTES + 4096) throw new Error('Oversized S3 migration index sidecar');
  await fs.promises.writeFile(file, encoded, { flag: 'wx', mode: 0o600 });
}

async function readMigrationIndex(file, namespace) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > MAX_ENCODED_BYTES + 4096) {
      throw new Error('Invalid or non-private S3 migration index sidecar');
    }
    const rows = JSON.parse(await handle.readFile('utf8'));
    validateRows(rows, namespace);
    return rows;
  } finally { await handle.close(); }
}

module.exports = { TABLE, INTERNAL_ROOT, maxEntries, MAX_ENCODED_BYTES, ATTEMPT,
  logicalKey, validateRows, encodeRows, readRows, snapshotDatabaseIndex, restoreDatabaseIndex,
  writeMigrationIndex, readMigrationIndex };
