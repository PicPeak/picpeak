/**
 * Migration 233: stored file paths become relative to the storage root.
 *
 * Generated PDFs, signature images, wet-signed uploads, inbound documents,
 * expense receipts and event logos were recorded as absolute paths. An
 * absolute path names one storage directory, so a `.picpeak` restore onto
 * another storage path, a moved storage directory, or the same database used
 * from a container and from the host left those rows pointing at files that
 * are not there. New rows are written relative (src/utils/storedPath.js);
 * this converts the existing ones.
 *
 * Only a value that is absolute AND lies under the storage root this process
 * resolves (STORAGE_PATH, or the default next to the backend) is rewritten,
 * and it is rewritten to exactly the path that joins back onto that root, so
 * the file it names does not change. Anything else — a path under another
 * root, one outside any storage folder, a value that is already relative — is
 * left alone; the read-side resolver still handles it. Re-running converts
 * nothing twice. Each row is updated only while it still holds the value that
 * was read, so a concurrent write is never overwritten. Hashes are untouched.
 *
 * down() turns the relative values back into absolute paths under the same
 * root, so an older release (which reads only absolute paths for these
 * columns) can open the files again after a rollback.
 */

const path = require('path');
const { getStoragePath } = require('../../src/config/storage');
const { STORED_PATH_COLUMNS, toStoredPath } = require('../../src/utils/storedPath');

async function rewrite(knex, convert) {
  let changed = 0;
  for (const { table, column } of STORED_PATH_COLUMNS) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, column))) continue;
    const rows = await knex(table).whereNotNull(column).select('id', column);
    for (const row of rows) {
      const next = convert(row[column]);
      if (!next || next === row[column]) continue;
      changed += await knex(table).where({ id: row.id, [column]: row[column] }).update({ [column]: next });
    }
  }
  return changed;
}

exports.up = async function(knex) {
  const changed = await rewrite(knex, (value) => (path.isAbsolute(value) ? toStoredPath(value) : value));
  if (changed) console.log(`233_relative_stored_paths: ${changed} stored path(s) made relative to ${getStoragePath()}`);
};

exports.down = async function(knex) {
  const root = path.resolve(getStoragePath());
  await rewrite(knex, (value) => {
    if (path.isAbsolute(value)) return value;
    const abs = path.resolve(root, value);
    return abs.startsWith(root + path.sep) ? abs : value;
  });
};
