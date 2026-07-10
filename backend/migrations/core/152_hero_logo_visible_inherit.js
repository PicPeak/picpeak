/**
 * Migration 152: make events.hero_logo_visible NULL-able so NULL means
 * "inherit the global branding_logo_display_hero setting" (#756).
 *
 * Before: hero_logo_visible was `boolean NOT NULL DEFAULT true`, and every
 * event got a concrete true/false snapshotted at creation. The global
 * "Show logo in hero section" toggle (branding_logo_display_hero) was only a
 * creation-time default and never affected existing galleries — so disabling
 * it did nothing to already-published galleries.
 *
 * After: NULL = inherit. gallery read-resolution falls back to the global
 * setting when the per-event value is NULL, so the global toggle controls
 * every gallery that hasn't been deliberately overridden per-event.
 *
 * Data backfill: NULL out the DEFAULTED `true` rows so they start inheriting
 * the global. A deliberate per-gallery hide (`false`) is kept — we can't tell a
 * defaulted-true from a chosen-true, but `false` is almost always a conscious
 * "hide it here", and nulling it could silently re-show a hidden logo.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('events', 'hero_logo_visible'))) return;

  const client = (knex.client.config.client || '').toLowerCase();
  if (client === 'pg' || client === 'postgresql') {
    await knex.raw('ALTER TABLE events ALTER COLUMN hero_logo_visible DROP DEFAULT');
    await knex.raw('ALTER TABLE events ALTER COLUMN hero_logo_visible DROP NOT NULL');
  } else {
    // SQLite (and others): knex recreates the table without the NOT NULL/default.
    await knex.schema.alterTable('events', (t) => {
      t.boolean('hero_logo_visible').nullable().alter();
    });
  }

  // Existing defaulted-`true` galleries now inherit the global toggle.
  await knex('events').where('hero_logo_visible', true).update({ hero_logo_visible: null });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasColumn('events', 'hero_logo_visible'))) return;
  // Re-materialise NULLs as the old default (true) before restoring NOT NULL.
  await knex('events').whereNull('hero_logo_visible').update({ hero_logo_visible: true });

  const client = (knex.client.config.client || '').toLowerCase();
  if (client === 'pg' || client === 'postgresql') {
    await knex.raw('ALTER TABLE events ALTER COLUMN hero_logo_visible SET DEFAULT true');
    await knex.raw('ALTER TABLE events ALTER COLUMN hero_logo_visible SET NOT NULL');
  } else {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('hero_logo_visible').notNullable().defaultTo(true).alter();
    });
  }
};
