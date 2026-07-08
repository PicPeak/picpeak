/**
 * Migration 153: make events.hero_logo_size NULL-able so NULL means "inherit
 * the global branding_logo_size" (#756 follow-up — the size counterpart of 152).
 *
 * Before: hero_logo_size was `varchar NOT NULL DEFAULT 'medium'`, snapshotted
 * from the global branding_logo_size at creation. The two gallery render paths
 * then disagreed — GalleryLayout read the global size live, while the
 * hero-header path used the per-event snapshot — so a hero logo could render at
 * different sizes on different layouts, and changing the global size didn't
 * update hero-header galleries.
 *
 * After: NULL = inherit. gallery read-resolution falls back to
 * branding_logo_size when the per-event value is NULL, and both render paths
 * consume that resolved size.
 *
 * Data backfill: NULL out ALL existing hero_logo_size so every gallery inherits
 * the global size going forward. Unlike a boolean we can't tell a defaulted
 * value from a chosen one — but nulling is the safe choice here: it restores the
 * live-global behaviour GalleryLayout already had, and the per-event size can be
 * re-set from the event's edit page.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('events', 'hero_logo_size'))) return;

  const client = (knex.client.config.client || '').toLowerCase();
  if (client === 'pg' || client === 'postgresql') {
    await knex.raw('ALTER TABLE events ALTER COLUMN hero_logo_size DROP DEFAULT');
    await knex.raw('ALTER TABLE events ALTER COLUMN hero_logo_size DROP NOT NULL');
  } else {
    await knex.schema.alterTable('events', (t) => {
      t.string('hero_logo_size', 20).nullable().alter();
    });
  }

  await knex('events').update({ hero_logo_size: null });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasColumn('events', 'hero_logo_size'))) return;
  await knex('events').whereNull('hero_logo_size').update({ hero_logo_size: 'medium' });

  const client = (knex.client.config.client || '').toLowerCase();
  if (client === 'pg' || client === 'postgresql') {
    await knex.raw("ALTER TABLE events ALTER COLUMN hero_logo_size SET DEFAULT 'medium'");
    await knex.raw('ALTER TABLE events ALTER COLUMN hero_logo_size SET NOT NULL');
  } else {
    await knex.schema.alterTable('events', (t) => {
      t.string('hero_logo_size', 20).notNullable().defaultTo('medium').alter();
    });
  }
};
