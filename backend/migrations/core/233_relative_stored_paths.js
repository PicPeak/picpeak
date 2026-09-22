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
 * The column list and the conversion are frozen here rather than imported
 * from src/, so a later change to the application code cannot change what
 * this migration did.
 *
 * Only a value that starts with the storage root this process resolves
 * (STORAGE_PATH, or the default next to the backend) followed by a separator
 * is rewritten, and it is rewritten to exactly the path that joins back onto
 * that root, so the file it names does not change. Anything else — a path
 * under another root, one outside any storage folder, a value that is
 * already relative — is left alone; the read-side resolver still handles it.
 * Re-running converts nothing twice. Each row is updated only while it still
 * holds the value that was read, so a concurrent write is never overwritten.
 * Hashes are untouched.
 *
 * down() turns relative values back into absolute paths under the same root,
 * so an older release (which reads only absolute paths for these columns) can
 * open the files again after a rollback. It cannot tell which values up()
 * converted, so it also makes absolute the values that were already relative
 * before up() ran; for an older release that is harmless, since each names
 * the same file under the same root either way.
 */

const path = require('path');

// This release has no generated_documents or contract_signers table (main's
// copy of this migration lists them too); every entry is still guarded by
// hasTable/hasColumn below.
const COLUMNS = [
  ['quotes', 'pdf_path'],
  ['invoices', 'pdf_path'],
  ['invoices', 'imported_pdf_path'],
  ['contracts', 'pdf_path'],
  ['contracts', 'signed_pdf_path'],
  ['contracts', 'signed_customer_signature_path'],
  ['contracts', 'signed_admin_signature_path'],
  ['inbound_documents', 'file_path'],
  ['expenses', 'receipt_path'],
  ['events', 'hero_logo_path'],
];

// The same resolution as src/config/storage.js at the time of writing.
const storageRoot = () => path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '../../../storage'));

async function rewrite(knex, select, convert) {
  let changed = 0;
  for (const [table, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, column))) continue;
    const rows = await select(knex(table).whereNotNull(column), column).select('id', column);
    for (const row of rows) {
      const next = convert(row[column]);
      if (!next || next === row[column]) continue;
      changed += await knex(table).where({ id: row.id, [column]: row[column] }).update({ [column]: next });
    }
  }
  return changed;
}

exports.up = async function(knex) {
  const root = storageRoot();
  const prefix = root + path.sep;
  const changed = await rewrite(
    knex,
    // LIKE narrows the read; the startsWith below is the actual test (LIKE
    // treats _ and % in the root as wildcards).
    (query, column) => query.where(column, 'like', `${prefix}%`),
    (value) => (value.startsWith(prefix)
      ? path.relative(root, value).split(path.sep).join('/')
      : value),
  );
  if (changed) console.log(`233_relative_stored_paths: ${changed} stored path(s) made relative to ${root}`);
};

exports.down = async function(knex) {
  const root = storageRoot();
  await rewrite(knex, (query) => query, (value) => {
    if (path.isAbsolute(value)) return value;
    const abs = path.resolve(root, value);
    return abs.startsWith(root + path.sep) ? abs : value;
  });
};
