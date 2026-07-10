/**
 * Migration 146: carry an event type on the quote.
 *
 * Quotes already snapshot event_name + event_date, but not the TYPE. Without it
 * the quote→event conversion (convertToEvent) had to hardcode 'wedding'. This
 * column lets the admin pick the type on the quote (from the event_types
 * catalog, stored as its slug_prefix — same shape as events.event_type), so the
 * conversion / booking flow's prepare_event can carry it through. Nullable: old
 * quotes and the "didn't pick one" case fall back to a configurable default.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (!(await knex.schema.hasColumn('quotes', 'event_type'))) {
    await knex.schema.alterTable('quotes', (t) => {
      t.string('event_type', 64);
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (await knex.schema.hasColumn('quotes', 'event_type')) {
    await knex.schema.alterTable('quotes', (t) => t.dropColumn('event_type'));
  }
};
