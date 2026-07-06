const { addColumnIfNotExists } = require('../helpers');

// Live Slideshow styling (migration 138 follow-up):
//   - a ZDF/ARD-ident-style watermark: a white, semi-transparent logo in a
//     corner of the projected slideshow (sourced from the site branding logo
//     or the event's own logo).
//   - a color filter applied to every slide (none / b&w / sepia / warm / cool
//     / vignette).
//   - per-EVENT-TYPE slideshow presets: a JSON blob on event_types that new
//     events of that type seed their slideshow settings from, so an admin sets
//     "weddings fade slowly with our white logo, sepia" once.
//
// All opt-in: watermark defaults OFF, colorfilter defaults 'none', and the
// type preset is NULL until configured — existing events/types are unchanged.
exports.up = async function up(knex) {
  // --- per-event live styling (seeded from the type preset on create) ---
  // Tri-state: NULL = inherit the global default (app_settings
  // slideshow_watermark_*), true/false = explicit per-event override.
  await addColumnIfNotExists(knex, 'events', 'show_watermark', (table) => {
    table.boolean('show_watermark').nullable();
  });
  // Which logo to overlay: 'logo' (light branding logo) | 'logo_dark' (dark-mode
  // branding logo) | 'favicon' | 'event' (event hero logo).
  await addColumnIfNotExists(knex, 'events', 'show_watermark_source', (table) => {
    table.string('show_watermark_source', 20).defaultTo('logo');
  });
  // Corner: top-left | top-right | bottom-left | bottom-right.
  await addColumnIfNotExists(knex, 'events', 'show_watermark_position', (table) => {
    table.string('show_watermark_position', 20).defaultTo('bottom-right');
  });
  // 0-100; rendered semi-transparent like a TV station ident.
  await addColumnIfNotExists(knex, 'events', 'show_watermark_opacity', (table) => {
    table.integer('show_watermark_opacity').defaultTo(60);
  });
  // 'white' = recolor the logo white (for dark/transparent marks, the TV-ident
  // look); 'original' = render as-is (for logos with their own filled box /
  // colors, e.g. a boxed badge that would otherwise become a white blob).
  await addColumnIfNotExists(knex, 'events', 'show_watermark_style', (table) => {
    table.string('show_watermark_style', 20).defaultTo('white');
  });
  // none | bw | sepia | warm | cool | vignette.
  await addColumnIfNotExists(knex, 'events', 'show_colorfilter', (table) => {
    table.string('show_colorfilter', 20).defaultTo('none');
  });

  // --- per-event-type slideshow preset (JSON; null = no preset) ---
  // Shape: { interval_ms, transition, transition_ms, watermark, watermark_source,
  //          watermark_position, watermark_opacity, colorfilter }. Single column
  // keeps the type table tidy; the create-event path reads it and seeds the new
  // event's show_* columns.
  await addColumnIfNotExists(knex, 'event_types', 'slideshow_preset', (table) => {
    table.text('slideshow_preset').nullable();
  });
};

exports.down = async function down() {
  // Safe rollback - intentionally no-op to avoid data loss (mirrors 074/138).
};
