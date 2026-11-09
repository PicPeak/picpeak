/**
 * Migration 354: client booking requests (#2440, part 2).
 *
 * A client picks a bookable service on the public booking page, fills in
 * its client-visible pricing factors (migration 353), picks a free slot and
 * sends a request. A request only holds the answers, the estimate and a
 * tentative hold on the slot until `hold_expires_at`. The customer, project
 * and quote are created when the admin accepts it, so a public form never
 * writes into the CRM.
 *
 *   booking_settings      singleton (id = 1): lead time, how far ahead,
 *                         slot step, buffer between bookings, hold length,
 *                         intro text. Working hours are the business hours
 *                         (business_profile.business_hours, migration 114)
 *                         in the business timezone.
 *   booking_blocks        manual blocks and blocked days (UTC instants).
 *   booking_requests      the requests. status: pending | accepted |
 *                         declined | expired. A pending request whose hold
 *                         has passed counts as expired.
 *   quote_line_item_presets
 *     bookable                    shown on the booking page
 *     booking_duration_minutes    slot length
 *     booking_duration_factor_id  a number factor whose value (hours) sets
 *                                 the slot length instead, e.g. "Session
 *                                 length"
 *
 * The `calendarBooking` feature flag (seeded in 088, a locked placeholder
 * until now) gates all of it.
 *
 * Additive and idempotent.
 */

const { formatBoolean } = require('../../src/utils/dbCompat');

async function addColumn(knex, table, column, build) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, (t) => build(t));
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('booking_settings'))) {
    await knex.schema.createTable('booking_settings', (t) => {
      t.integer('id').primary();
      t.integer('lead_time_hours').notNullable().defaultTo(48);
      t.integer('horizon_days').notNullable().defaultTo(180);
      t.integer('slot_step_minutes').notNullable().defaultTo(30);
      t.integer('buffer_minutes').notNullable().defaultTo(0);
      t.integer('hold_hours').notNullable().defaultTo(72);
      t.text('intro_text');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }
  const settings = await knex('booking_settings').where({ id: 1 }).first();
  if (!settings) await knex('booking_settings').insert({ id: 1 });

  if (!(await knex.schema.hasTable('booking_blocks'))) {
    await knex.schema.createTable('booking_blocks', (t) => {
      t.increments('id').primary();
      t.timestamp('starts_at').notNullable();
      t.timestamp('ends_at').notNullable();
      t.string('note', 255);
      t.integer('created_by').unsigned().references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['starts_at']);
    });
  }

  if (!(await knex.schema.hasTable('booking_requests'))) {
    await knex.schema.createTable('booking_requests', (t) => {
      t.increments('id').primary();
      // Public reference shown to the client; never an access token.
      t.string('reference', 16).notNullable().unique();
      t.string('status', 16).notNullable().defaultTo('pending');
      t.integer('preset_id').unsigned().references('id').inTable('quote_line_item_presets').onDelete('SET NULL');
      t.string('service_name', 128).notNullable();
      t.timestamp('starts_at').notNullable();
      t.timestamp('ends_at').notNullable();
      t.timestamp('hold_expires_at').notNullable();
      t.string('name', 160).notNullable();
      t.string('email', 255).notNullable();
      t.string('phone', 40);
      t.string('company', 160);
      t.text('message');
      t.string('language', 8);
      // The pricing-factor snapshot (values + definitions) and the priced
      // lines, as computed when the request came in.
      t.text('pricing_factors');
      t.text('estimate_lines');
      t.bigInteger('estimate_minor').notNullable().defaultTo(0);
      t.string('currency', 3).notNullable();
      t.timestamp('decided_at');
      t.integer('decided_by').unsigned().references('id').inTable('admin_users').onDelete('SET NULL');
      t.text('decline_reason');
      t.integer('customer_account_id').unsigned().references('id').inTable('customer_accounts').onDelete('SET NULL');
      t.integer('project_id').unsigned().references('id').inTable('projects').onDelete('SET NULL');
      t.integer('quote_id').unsigned().references('id').inTable('quotes').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['status', 'starts_at']);
    });
  }

  await addColumn(knex, 'quote_line_item_presets', 'bookable', (t) => t.boolean('bookable').notNullable().defaultTo(false));
  await addColumn(knex, 'quote_line_item_presets', 'booking_duration_minutes', (t) => t.integer('booking_duration_minutes'));
  await addColumn(knex, 'quote_line_item_presets', 'booking_duration_factor_id', (t) => t.integer('booking_duration_factor_id'));

  const flag = await knex('feature_flags').where({ key: 'calendarBooking' }).first();
  if (!flag) await knex('feature_flags').insert({ key: 'calendarBooking', value: formatBoolean(false) });
};

exports.down = async function (knex) {
  for (const column of ['booking_duration_factor_id', 'booking_duration_minutes', 'bookable']) {
    if (await knex.schema.hasColumn('quote_line_item_presets', column)) {
      await knex.schema.alterTable('quote_line_item_presets', (t) => t.dropColumn(column));
    }
  }
  await knex.schema.dropTableIfExists('booking_requests');
  await knex.schema.dropTableIfExists('booking_blocks');
  await knex.schema.dropTableIfExists('booking_settings');
};
