const { bootCrmDb } = require('./helpers/crmDb');

// Contract for SEED_ONLY_TABLES (picpeakImportService.js). A restore clears
// every exported table the archive's manifest does not list, EXCEPT the
// SEED_ONLY_TABLES, whose migration-seeded rows would otherwise be gone for
// good. That list is maintained by hand, so pin it against the migrations
// themselves: run every core migration on a fresh SQLite DB and require that
// each exported table holding rows is classified, either in SEED_ONLY_TABLES
// or in the exemption list below. A new seeding migration fails here until
// someone decides which side its table belongs on; a SEED_ONLY_TABLES entry
// that no migration seeds any more fails here too.

// Seeded by migrations but deliberately NOT seed-only. Every table below is
// created by the base schema (src/database/db.js) or a core migration numbered
// 150 or lower, i.e. before the .picpeak format existed (it shipped with 150
// as the newest migration). Every .picpeak archive therefore lists these
// tables, the "archive predates the table" skip can never apply, and the
// restore replaces them with the archive's own rows like any other table.
// Some also re-seed at runtime (roles/permissions via _permissionsBoot.js,
// backup_paths via _backupPathsBoot.js), a second, independent reason.
const SEEDED_BUT_NOT_SEED_ONLY = new Set([
  'migrations',                   // migration ledger itself (runner bookkeeping)
  'app_settings',                 // db.js base schema
  'cms_pages',                    // db.js base schema
  'photo_categories',             // db.js base schema
  'email_templates',              // db.js / 059
  'css_templates',                // 052
  'roles',                        // 054; _permissionsBoot.js re-seeds
  'permissions',                  // 055; _permissionsBoot.js re-seeds
  'role_permissions',             // 056; _permissionsBoot.js re-seeds
  'event_types',                  // 061
  'email_template_translations',  // 075
  'feature_flags',                // 088
  'business_profile',             // 107
  'backup_paths',                 // 109; _backupPathsBoot.js re-seeds
]);

let db; let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
}, 120000);
afterAll(async () => { if (cleanup) await cleanup(); });

it('every table a migration seeds is classified as seed-only or explicitly exempt', async () => {
  const { listDataTables } = require('../../src/services/picpeakExportService');
  const { SEED_ONLY_TABLES } = require('../../src/services/picpeakImportService');

  const seeded = [];
  for (const table of await listDataTables()) {
    const [{ c }] = await db(table).count({ c: '*' });
    if (Number(c) > 0) seeded.push(table);
  }

  const overlap = [...SEED_ONLY_TABLES].filter((t) => SEEDED_BUT_NOT_SEED_ONLY.has(t));
  expect(overlap).toEqual([]);

  const classified = [...SEED_ONLY_TABLES, ...SEEDED_BUT_NOT_SEED_ONLY].sort();
  expect(seeded.sort()).toEqual(classified);
});
