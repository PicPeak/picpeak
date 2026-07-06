const { addColumnIfNotExists, createIndexIfNotExists } = require('../helpers');

// Live Slideshow ("Diashow") link for live events. A SECOND, token-only
// share surface that mirrors the client-access pattern (migration 074):
// a dedicated fullscreen kiosk URL `/gallery/:slug/show/:token` that
// auto-picks-up newly uploaded photos while it runs.
//
// Opt-in by design: `show_share_token` stays NULL until the admin clicks
// "Generate slideshow link", and the public `/show/` route 404s while it
// is null. The three settings columns drive the running projector and can
// be changed LIVE from the admin panel (a short settings poll on the show
// page picks them up within a few seconds) — they carry sensible defaults
// so an existing event is fully configured the moment a token is minted.
exports.up = async function up(knex) {
  // Token IS the secret (no gallery password). Unique so a stray collision
  // can never point two events at one link.
  await addColumnIfNotExists(knex, 'events', 'show_share_token', (table) => {
    table.string('show_share_token', 64).nullable().unique();
  });

  // Per-slide display time in ms (how long each photo stays on screen).
  await addColumnIfNotExists(knex, 'events', 'show_interval_ms', (table) => {
    table.integer('show_interval_ms').defaultTo(5000);
  });

  // Transition style between slides: crossfade | cut | slide | kenburns.
  await addColumnIfNotExists(knex, 'events', 'show_transition', (table) => {
    table.string('show_transition', 20).defaultTo('crossfade');
  });

  // Transition animation duration in ms (how fast the transition plays).
  await addColumnIfNotExists(knex, 'events', 'show_transition_ms', (table) => {
    table.integer('show_transition_ms').defaultTo(800);
  });

  // Lookup is always by token; index it for the public /show/ route.
  await createIndexIfNotExists(knex, 'events', ['show_share_token'], 'idx_events_show_share_token');
};

exports.down = async function down() {
  // Safe rollback - intentionally no-op to avoid data loss (mirrors 074).
};
