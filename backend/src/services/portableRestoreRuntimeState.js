'use strict';

const migration = require('../../migrations/core/280_portable_restore_control');

const TABLES = Object.freeze({
  portable_restore_control: { key: 'id', text: ['options_json', 'worker_lease_json', 'result_json'] },
  portable_restore_instances: { key: 'instance_id', text: ['lease_json'] },
  portable_restore_commits: { key: 'attempt_id', text: [] },
});
const MAX_ROWS = 100000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;

// Native dumps intentionally omit runtime authority. Replacing the database
// must preserve the TARGET cohort, never import the source installation's
// fence or forget a still-running replica. The caller owns upload.lease over
// snapshot, database replacement and replay; startup registration uses it too.
async function snapshot(knex) {
  return knex.transaction(async trx => {
    const result = {};
    let bytes = 0;
    let count = 0;
    for (const [table, policy] of Object.entries(TABLES)) {
      result[table] = [];
      if (!(await trx.schema.hasTable(table))) continue;
      for (const column of policy.text) {
        const oversized = await trx(table).whereRaw('length(??) > ?', [column, MAX_RECORD_BYTES]).first(policy.key);
        if (oversized) throw new Error('Portable runtime state exceeds its record limit');
      }
      let last;
      for (;;) {
        const query = trx(table).select('*').orderBy(policy.key).limit(100);
        if (last !== undefined) query.where(policy.key, '>', last);
        const rows = await query;
        for (const row of rows) {
          const encoded = JSON.stringify(row);
          const size = Buffer.byteLength(encoded);
          bytes += size;
          count += 1;
          if (size > MAX_RECORD_BYTES || bytes > MAX_BYTES || count > MAX_ROWS) {
            throw new Error('Portable runtime state exceeds its bounded snapshot limit');
          }
          result[table].push(row);
        }
        if (rows.length < 100) break;
        last = rows[rows.length - 1][policy.key];
      }
    }
    return result;
  });
}

async function restore(knex, state) {
  if (!state || Object.keys(state).length !== Object.keys(TABLES).length ||
      Object.keys(state).some(table => !Object.hasOwn(TABLES, table))) {
    throw new Error('Invalid target portable runtime snapshot');
  }
  let bytes = 0;
  let count = 0;
  for (const table of Object.keys(TABLES)) {
    if (!Array.isArray(state[table])) throw new Error('Invalid target portable runtime rows');
    for (const row of state[table]) {
      const size = Buffer.byteLength(JSON.stringify(row));
      bytes += size;
      count += 1;
      if (!row || typeof row !== 'object' || Array.isArray(row) || size > MAX_RECORD_BYTES ||
          bytes > MAX_BYTES || count > MAX_ROWS) throw new Error('Invalid target portable runtime rows');
    }
  }
  await knex.transaction(async trx => {
    await migration.up(trx);
    for (const table of Object.keys(TABLES)) {
      await trx(table).del();
      const rows = state[table];
      const names = new Set();
      for (const row of rows) for (const name of Object.keys(row)) names.add(name);
      const columns = names.size;
      const batchSize = Math.max(1, Math.min(100, Math.floor(800 / Math.max(1, columns))));
      for (let start = 0; start < rows.length; start += batchSize) {
        await trx(table).insert(rows.slice(start, start + batchSize));
      }
    }
  });
}

module.exports = { snapshot, restore };
