/**
 * Migration 088: Feature flags table.
 *
 * Backs the Features tab on the admin Settings page. Flags gate which
 * product surfaces appear in the main sidebar and (in future PRs) which
 * background jobs run.
 *
 * Existing-vs-fresh detection:
 *   The Features tab introduces a curated set of "default ON" flags
 *   (galleries, reminderEmails, analytics, userManagement) and "default
 *   OFF" flags for surfaces that aren't built yet (calendar, quotes,
 *   bills, messaging). For a brand-new install those defaults are right
 *   out of the box. For an existing install, we want every flag ON so
 *   nothing in the admin's UI silently disappears the moment they
 *   upgrade — they can opt out later via the Features tab.
 *
 *   Detection rule: if the `events` table has any rows at migration
 *   time, treat this as an existing install. Empty events = fresh.
 *   This is single-shot (the migration only runs once) and atomic
 *   (no race window). It picks up the rare edge case where an admin
 *   upgrades immediately after running setup but before creating an
 *   event — they'll get fresh-install defaults, which is acceptable
 *   (they can flip flags on the Features page).
 *
 * Schema:
 *   - key (PK): the flag identifier (matches FeatureKey on the frontend)
 *   - value: the boolean state
 *   - updated_at: last-changed timestamp
 *   - updated_by: admin id of the last person who flipped it (nullable
 *     for the migration-seeded rows)
 */

exports.up = async function(knex) {
  console.log('Running migration: 088_add_feature_flags');

  const exists = await knex.schema.hasTable('feature_flags');
  if (!exists) {
    await knex.schema.createTable('feature_flags', (table) => {
      table.string('key', 64).primary();
      table.boolean('value').notNullable();
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.integer('updated_by').references('id').inTable('admin_users').onDelete('SET NULL');
    });
    console.log('  created feature_flags table');
  } else {
    console.log('  feature_flags table already exists, skipping create');
  }

  // Detect install age. Use events table — it's user-created content,
  // unlike admin_users which is seeded by migration 001.
  const eventCountRow = await knex('events').count({ count: '*' }).first();
  const eventCount = parseInt(eventCountRow?.count || 0, 10);
  const isExistingInstall = eventCount > 0;
  console.log(`  detected ${isExistingInstall ? 'EXISTING' : 'FRESH'} install (events count: ${eventCount})`);

  // Spec defaults (frontend/src/contexts/FeatureFlagsContext.tsx).
  // For an existing install every flag becomes TRUE so nothing
  // disappears from the admin UI on upgrade.
  const FLAGS_FRESH = {
    galleries: true,         // always-on, locked
    reminderEmails: true,    // existing cron, locked-on for now
    calendar: false,         // surface not built yet
    calendarBooking: false,  // ditto
    quotes: false,           // surface not built yet
    bills: false,            // surface not built yet (depends on quotes)
    messaging: false,        // surface not built yet
    analytics: true,         // existing surface
    userManagement: true,    // existing surface
  };
  const flagsToSeed = isExistingInstall
    ? Object.fromEntries(Object.keys(FLAGS_FRESH).map((k) => [k, true]))
    : FLAGS_FRESH;

  for (const [key, value] of Object.entries(flagsToSeed)) {
    const existingRow = await knex('feature_flags').where({ key }).first();
    if (!existingRow) {
      await knex('feature_flags').insert({ key, value });
    }
  }
  console.log(`  seeded ${Object.keys(flagsToSeed).length} flags`);

  console.log('Migration 088_add_feature_flags completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 088_add_feature_flags');
  await knex.schema.dropTableIfExists('feature_flags');
};
