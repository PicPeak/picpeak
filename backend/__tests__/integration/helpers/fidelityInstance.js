'use strict';

/**
 * One PicPeak instance for picpeakFidelityRoundtrip.test.js, run as its own
 * Node process so it gets its own db.js binding (the module binds its knex
 * pool at require time, so two databases cannot share one process).
 *
 *   node fidelityInstance.js source <outDir>
 *     migrate, seed every table it can, write a few storage files, export.
 *   node fidelityInstance.js restore <picpeakPath> <outDir>
 *     migrate a fresh database, restore the archive, export again.
 *
 * The engine comes from the environment exactly like the app: SQLite via
 * TEST_DATABASE_PATH, Postgres via DATABASE_CLIENT=pg + DB_*. The result is
 * printed as one `FIDELITY_RESULT:<json>` line on stdout.
 *
 * The seeding knows nothing about any feature. It introspects the schema and
 * inserts one synthetic row into every exported table that the migrations
 * left empty, parents before children, so a column added tomorrow is covered
 * without anyone touching this file. Tables it cannot fill (a CHECK it cannot
 * satisfy, a required parent that stayed empty) are reported, and the test
 * pins that list.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'fidelity-test-secret-at-least-32-characters';
process.env.PDF_RENDER_ISOLATION = process.env.PDF_RENDER_ISOLATION || 'off';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// The operator's account is the one row a restore deliberately keeps from
// the TARGET (picpeakImportService preserves the current admin's
// credentials). Both instances give it the same fixed values, so that
// preservation is invisible to the comparison instead of excluded from it.
const OPERATOR = {
  username: 'fidelity-operator',
  email: 'fidelity-operator@example.com',
  // A fixed bcrypt-shaped string (nothing signs in with it), identical in
  // source and target.
  password_hash: '$2b$04$4b0aQ0fAkhv2oQe6l3m7ruzFq2t8M6x3KcGyC6uQ1n0Q8yU1m8x1e',
  must_change_password: false,
  is_active: true,
  created_at: '2024-08-11T18:13:20.000Z',
  updated_at: '2024-08-11T18:13:20.000Z',
};

// A second admin, only in the source, so rows that point at an admin are not
// all the operator's (whose rows a restore treats specially).
const COLLEAGUE = { ...OPERATOR, username: 'fidelity-colleague', email: 'fidelity-colleague@example.com' };

// Files under the roots a .picpeak always carries, with a non-ASCII name and
// binary bytes, so the file half of the manifest is compared too.
const FILES = {
  'business-docs/fidelity/contract ü.pdf': Buffer.from('%PDF-1.4\nfidelity contract\n%%EOF\n'),
  'uploads/fidelity/logo.png': crypto.createHash('sha512').update('fidelity-logo').digest(),
  'transfers/fidelity/delivery.bin': Buffer.from([0, 1, 2, 3, 254, 255]),
};

const FIXED_DATE = new Date('2024-08-11T18:13:20.000Z');

// The few columns where a synthetic value would break an invariant the export
// or restore rightly enforces (a storage key must sit under its recovery root
// and name a real file, ...). Merged over the synthetic row. Keep this short:
// it is the per-table knowledge the generic seeding otherwise avoids.
const OVERRIDES = {
  // Staging assets are temporary uploads the recovery inventory skips, so
  // the row needs no file on disk.
  print_sales_assets: { kind: 'staging' },
  // Postgres-only CHECK (migration 078 adds it on pg alone), so a SQLite
  // source cannot tell the seeding which values a Postgres target accepts.
  event_feedback_settings: { identity_mode: 'simple' },
  // The restore drops archived passkeys on the operator's own account
  // (preserveOperatorPasskeys), so the seeded key belongs to a colleague and
  // is compared like any other row.
  admin_webauthn_credentials: async db => ({
    admin_user_id: (await db('admin_users').where({ email: COLLEAGUE.email }).first('id')).id,
  }),
};

async function bootInstance() {
  const { bootCrmDb } = require('./crmDb');
  const context = await bootCrmDb();
  const { db } = context;
  const role = await db('roles').where({ name: 'super_admin' }).first();
  const [inserted] = await db('admin_users').insert({ ...OPERATOR, role_id: role.id }).returning('id');
  const operatorId = inserted?.id ?? inserted;
  return { ...context, operatorId };
}

const isPg = db => db.client.config.client === 'pg';
const rowsOf = (db, result) => (isPg(db) ? result.rows : result);

// { column: { type, nullable, hasDefault, maxLength, autoIncrement } }
async function describeColumns(db, table) {
  if (isPg(db)) {
    const result = await db.raw(`
      SELECT column_name, data_type, udt_name, is_nullable, column_default,
             character_maximum_length, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ?
      ORDER BY ordinal_position`, [table]);
    return Object.fromEntries(result.rows.map(c => [c.column_name, {
      type: c.data_type === 'USER-DEFINED' ? 'enum' : c.data_type,
      nullable: c.is_nullable === 'YES',
      hasDefault: c.column_default !== null,
      maxLength: c.character_maximum_length,
      autoIncrement: c.is_identity === 'YES' || /^nextval\(/.test(c.column_default || ''),
      udt: c.udt_name,
    }]));
  }
  const info = await db.raw(`PRAGMA table_info(${JSON.stringify(table)})`);
  const pkColumns = info.filter(c => c.pk);
  return Object.fromEntries(info.map(c => [c.name, {
    type: String(c.type || '').toLowerCase(),
    nullable: !c.notnull && !c.pk,
    hasDefault: c.dflt_value !== null,
    maxLength: Number((/\((\d+)\)/.exec(c.type || '') || [])[1]) || null,
    autoIncrement: pkColumns.length === 1 && c.pk === 1 && /int/i.test(c.type || ''),
  }]));
}

// [{ column, table, to }]
async function describeForeignKeys(db, table) {
  if (isPg(db)) {
    const result = await db.raw(`
      SELECT kcu.column_name AS column, ccu.table_name AS "table", ccu.column_name AS "to"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = ?`, [table]);
    return result.rows;
  }
  const rows = await db.raw(`PRAGMA foreign_key_list(${JSON.stringify(table)})`);
  return rows.map(r => ({ column: r.from, table: r.table, to: r.to || 'id' }));
}

// Allowed literals for enum-like columns: knex enums are a CHECK ... IN (...)
// on SQLite and a CHECK ... = ANY (ARRAY[...]) (or a native enum) on Postgres.
async function describeAllowedValues(db, table, columns) {
  const allowed = {};
  const literals = text => [...text.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
  if (isPg(db)) {
    const checks = await db.raw(`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c' AND n.nspname = 'public' AND t.relname = ?`, [table]);
    for (const { def } of checks.rows) {
      for (const column of Object.keys(columns)) {
        if (allowed[column]) continue;
        const pattern = new RegExp(`\\(\\(?"?${column}"?\\)?(?:::[a-z ]+)? = ANY|"?\\b${column}\\b"?(?:\\)?::[a-z ]+)? IN \\(`);
        if (pattern.test(def)) {
          const values = literals(def);
          if (values.length) allowed[column] = values;
        }
      }
    }
    for (const [column, meta] of Object.entries(columns)) {
      if (meta.type !== 'enum' || allowed[column]) continue;
      const labels = await db.raw(`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = ? ORDER BY e.enumsortorder`, [meta.udt]);
      allowed[column] = labels.rows.map(r => r.enumlabel);
    }
    return allowed;
  }
  const [master] = await db.raw('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['table', table]);
  const sql = master?.sql || '';
  for (const column of Object.keys(columns)) {
    const match = new RegExp(`[\`"\\[]?${column}[\`"\\]]?\\s+in\\s*\\(([^)]*)\\)`, 'i').exec(sql);
    if (match) {
      const values = literals(match[1]);
      if (values.length) allowed[column] = values;
    }
  }
  return allowed;
}

function syntheticValue(table, column, meta, allowed) {
  if (allowed) return allowed[0];
  const type = meta.type;
  const text = () => {
    const value = `fx-${table}-${column}`;
    return meta.maxLength ? value.slice(0, meta.maxLength) : value;
  };
  if (/bool/.test(type) || type === 'tinyint(1)') return true;
  if (/^(timestamp|datetime)/.test(type)) return FIXED_DATE;
  if (/^date$/.test(type)) return '2024-08-11';
  if (/^time/.test(type)) return '18:13:20';
  if (/json/.test(type)) return JSON.stringify({ fixture: table, nested: { column, list: [1, 'ü'] } });
  // knex's uuid() is char(36) on SQLite and a native uuid on Postgres.
  if (/uuid/.test(type) || type === 'char(36)') return crypto.randomUUID();
  if (/blob|bytea|binary/.test(type)) return Buffer.from(`fx-${table}-${column}`);
  // Small values: they satisfy the range CHECKs (a 1-5 rating) and the
  // narrow numerics (numeric(3,2)) that only Postgres enforces.
  if (/int/.test(type)) return 1;
  if (/real|float|double|numeric|decimal/.test(type)) return 1.5;
  return text();
}

async function primaryKeyValue(db, table, column) {
  const row = await db(table).whereNotNull(column).first(column);
  return row ? row[column] : undefined;
}

/**
 * Insert one synthetic row into every listed table that is still empty.
 * Returns { filled, unfilled: { table: reason } }.
 */
async function fillEmptyTables(db, tables) {
  const pending = new Set();
  for (const table of tables) {
    const [{ count }] = await db(table).count({ count: '*' });
    if (!Number(count)) pending.add(table);
  }
  const filled = [];
  const reasons = {};
  // Parents before children: retry while any pass makes progress.
  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const table of [...pending]) {
      const columns = await describeColumns(db, table);
      const foreignKeys = await describeForeignKeys(db, table);
      const allowed = await describeAllowedValues(db, table, columns);
      const row = {};
      let blocked = null;
      for (const [column, meta] of Object.entries(columns)) {
        if (meta.autoIncrement) continue;
        const fk = foreignKeys.find(f => f.column === column);
        if (fk) {
          const value = fk.table === table ? undefined : await primaryKeyValue(db, fk.table, fk.to);
          if (value === undefined) {
            if (meta.nullable) { row[column] = null; continue; }
            blocked = `required parent ${fk.table}.${fk.to} is empty`;
            break;
          }
          row[column] = value;
          continue;
        }
        row[column] = syntheticValue(table, column, meta, allowed[column]);
      }
      if (blocked) { reasons[table] = blocked; continue; }
      const override = OVERRIDES[table];
      Object.assign(row, typeof override === 'function' ? await override(db) : override);
      // Full row first; when a CHECK or trigger refuses it, retry with only
      // the columns the table requires.
      const attempts = [row, Object.fromEntries(Object.entries(row)
        .filter(([column]) => !columns[column].nullable && !columns[column].hasDefault))];
      for (const attempt of attempts) {
        try {
          await db.transaction(trx => trx(table).insert(attempt));
          filled.push(table);
          pending.delete(table);
          delete reasons[table];
          progress = true;
          break;
        } catch (error) {
          reasons[table] = String(error.message).split('\n')[0].slice(0, 300);
        }
      }
    }
  }
  return { filled, unfilled: Object.fromEntries([...pending].sort().map(t => [t, reasons[t] || 'not attempted'])) };
}

async function writeFiles() {
  for (const [relative, bytes] of Object.entries(FILES)) {
    const target = path.join(process.env.STORAGE_PATH, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

async function exportTo(outDir) {
  const { createPicpeak } = require('../../../src/services/picpeakExportService');
  const { filePath, manifest } = await createPicpeak({ includePhotos: false, outDir });
  return { filePath, manifest };
}

async function source(outDir) {
  const instance = await bootInstance();
  try {
    const { listDataTables } = require('../../../src/services/picpeakExportService');
    const role = await instance.db('roles').where({ name: 'super_admin' }).first();
    await instance.db('admin_users').insert({ ...COLLEAGUE, role_id: role.id });
    const seeding = await fillEmptyTables(instance.db, await listDataTables());
    await writeFiles();
    return { ...await exportTo(outDir), seeding, engine: isPg(instance.db) ? 'pg' : 'sqlite' };
  } finally {
    await instance.cleanup();
  }
}

async function restore(picpeakPath, outDir) {
  const instance = await bootInstance();
  try {
    const { importFromPicpeak } = require('../../../src/services/picpeakImportService');
    const result = await importFromPicpeak({ picpeakPath, currentAdminId: instance.operatorId });
    // Column kinds whose values a SQLite archive spells differently: a pg
    // `date` keeps the calendar day of a SQLite epoch, and a pg json column
    // holds what SQLite stores as JSON text. The test compares by kind.
    const columnKinds = {};
    if (isPg(instance.db)) {
      const result = await instance.db.raw(`SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('date', 'json', 'jsonb')`);
      for (const row of result.rows) {
        (columnKinds[row.table_name] ||= {})[row.column_name] = row.data_type === 'date' ? 'date' : 'json';
      }
    }
    return { ...await exportTo(outDir), restore: result, columnKinds, engine: isPg(instance.db) ? 'pg' : 'sqlite' };
  } finally {
    const native = require.cache[require.resolve('../../../src/services/nativeProcessRunner')];
    if (native) await native.exports.stop();
    await instance.cleanup();
  }
}

if (require.main === module) {
  const [mode, ...args] = process.argv.slice(2);
  const run = mode === 'source' ? () => source(args[0]) : mode === 'restore' ? () => restore(args[0], args[1]) : null;
  if (!run) { console.error(`unknown mode ${mode}`); process.exit(2); }
  run().then(result => {
    process.stdout.write(`\nFIDELITY_RESULT:${JSON.stringify(result)}\n`);
    // Services (schedulers, pools) may hold the loop open; the result is out.
    process.exit(0);
  }, error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}

module.exports = { OPERATOR, FILES };
