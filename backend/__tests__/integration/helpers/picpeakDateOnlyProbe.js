'use strict';

// Child process for picpeakDateOnly.test.js. A jest worker cannot change its
// own time zone (process.env there is a copy), and node-pg turns a `date` into
// a Date in the zone of the process that reads it, so each zone runs here
// with TZ set by the parent. Prints one JSON line with what each roundtrip
// stored and wrote.
//
//   TZ=Europe/Berlin PICPEAK_PG_TEST_URL=postgres://… node picpeakDateOnlyProbe.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const knexLib = require('knex');

const SERVICES = path.resolve(__dirname, '../../../src/services');
const TABLE = 'picpeak_date_probe';
const DAYS = ['2024-08-11', '2024-01-15', '2024-12-31'];
const CLIENT_INSTANTS = ['2024-08-11T13:00:00.000Z', '2024-08-10T22:00:00.000Z'];

// Load a service against `db` on `client`, as the jest suites do with doMock.
function load(client, db, service) {
  const stubs = {
    [require.resolve('../../../knexfile')]: { client },
    [require.resolve('../../../src/database/db')]: { db },
  };
  const saved = {};
  for (const [file, exports] of Object.entries(stubs)) {
    saved[file] = require.cache[file];
    const mod = new Module(file);
    mod.filename = file;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[file] = mod;
  }
  const target = require.resolve(path.join(SERVICES, service));
  delete require.cache[target];
  const loaded = require(target);
  delete require.cache[target];
  for (const [file, mod] of Object.entries(saved)) {
    if (mod) require.cache[file] = mod;
    else delete require.cache[file];
  }
  return loaded;
}

async function main() {
  const pgDb = knexLib({ client: 'pg', connection: process.env.PICPEAK_PG_TEST_URL });
  const sqliteDb = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-date-'));
  try {
    await pgDb.raw(`DROP TABLE IF EXISTS ${TABLE}`);
    for (const db of [pgDb, sqliteDb]) {
      await db.schema.createTable(TABLE, (t) => {
        t.integer('id').primary();
        t.date('d');
        t.timestamp('ts', { useTz: true });
      });
    }
    const pgExport = load('pg', pgDb, 'picpeakExportService');
    const pgImport = load('pg', pgDb, 'picpeakImportService');
    const sqliteExport = load('sqlite3', sqliteDb, 'picpeakExportService');

    const readNdjson = () => fs.readFileSync(path.join(dataDir, `${TABLE}.ndjson`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    // The stored day as text, so the driver's own parsing plays no part.
    const storedDays = async () => (await pgDb.raw(`SELECT d::text AS d FROM ${TABLE} ORDER BY id`)).rows.map((r) => r.d);
    // The import's row preparation for a pg target (prepareEngineRows, which
    // replaceAllTables calls; picpeakDateOnlyImport.test.js pins that).
    const importRows = (rows, crossEngine) => pgDb.transaction(async (trx) => {
      await trx(TABLE).del();
      const types = crossEngine ? await pgImport.typedColumnsFor(trx, TABLE) : null;
      const dateOnlyColumns = (await pgImport.dateOnlyColumnsByTable(trx)).get(TABLE) || [];
      const prepared = pgImport.prepareEngineRows(rows, { crossEngine, types, dateOnlyColumns });
      await trx.batchInsert(TABLE, prepared, prepared.length);
    });
    const localMidnight = (day) => {
      const [y, m, d] = day.split('-').map(Number);
      return new Date(y, m - 1, d);
    };

    const out = { zone: process.env.TZ, pgToPg: [], sqliteToPg: {}, legacy: {} };

    // pg → pg, twice over.
    await pgDb(TABLE).insert([
      ...DAYS.map((d, i) => ({ id: i + 1, d, ts: '2024-08-11T10:00:00.000Z' })),
      { id: DAYS.length + 1, d: null, ts: null },
    ]);
    for (let round = 0; round < 2; round += 1) {
      await pgExport.writeTableNdjson(TABLE, dataDir);
      const rows = readNdjson();
      await importRows(rows, false);
      out.pgToPg.push({ archived: rows.map((r) => r.d), archivedTs: rows[0].ts, stored: await storedDays() });
    }

    // sqlite → pg: date strings, Dates the app wrote (epoch ms of local
    // midnight), and full instants an API client sent as they were. SQLite
    // shows the first ten characters of those (toDateOnly).
    await sqliteDb(TABLE).insert([
      ...DAYS.map((d, i) => ({ id: i + 1, d, ts: Date.UTC(2024, 7, 11, 10) })),
      ...DAYS.map((d, i) => ({ id: DAYS.length + i + 1, d: localMidnight(d), ts: null })),
      ...CLIENT_INSTANTS.map((d, i) => ({ id: 2 * DAYS.length + i + 1, d, ts: null })),
    ]);
    await sqliteExport.writeTableNdjson(TABLE, dataDir);
    out.sqliteToPg.archived = readNdjson().map((r) => r.d);
    await importRows(readNdjson(), true);
    out.sqliteToPg.stored = await storedDays();
    await pgExport.writeTableNdjson(TABLE, dataDir);
    out.sqliteToPg.reexported = readNdjson().map((r) => r.d);

    // A pg archive written before the fix: the UTC instant of local midnight.
    out.legacy.archived = DAYS.map((d) => localMidnight(d).toISOString());
    await importRows(out.legacy.archived.map((d, i) => ({ id: i + 1, d, ts: null })), false);
    out.legacy.stored = await storedDays();

    process.stdout.write(`${JSON.stringify(out)}\n`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    await pgDb.raw(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await pgDb.destroy();
    await sqliteDb.destroy();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
