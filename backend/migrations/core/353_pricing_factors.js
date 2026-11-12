/**
 * Migration 353: pricing factors on catalogue items (#2440, part 1).
 *
 * A catalogue item (quote_line_item_presets) keeps its base price. Factors
 * the admin defines change it: session length, kind of work, travel zone,
 * editing effort, number of deliverables. One factor library, attached to
 * as many items as needed.
 *
 *   pricing_factors          the library. input_type:
 *                              number  a quantity; effect per_unit
 *                                      (amount × units above included_units)
 *                                      or step (amount per started step_size
 *                                      above included_units)
 *                              toggle  yes/no; effect fixed or percent
 *                              choice  one of the options
 *                              zone    travel zone, matched by postcode
 *                                      against the options' postcode lists
 *                            client_visible: shown on the public booking
 *                            page (part 2); admin-only factors use their
 *                            default there.
 *   pricing_factor_options   choice / zone options, each with its own
 *                            effect (fixed amount or percent of the base).
 *   quote_preset_factors     which factors an item uses, in order.
 *
 * Line items (quotes AND invoices, so a converted quote keeps it):
 *   pricing_factors          JSON on the parent line: the values chosen and
 *                            the factor definitions as priced, so the line
 *                            explains itself after the library changes. The
 *                            price itself lives in ordinary sub-lines.
 *
 * Additive and idempotent.
 */

const LINE_ITEM_TABLES = ['quote_line_items', 'invoice_line_items'];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_factors'))) {
    await knex.schema.createTable('pricing_factors', (t) => {
      t.increments('id').primary();
      t.string('name', 128).notNullable();
      t.text('description');
      t.string('input_type', 16).notNullable(); // number | toggle | choice | zone
      t.string('effect', 16); // number: per_unit | step; toggle: fixed | percent
      t.string('unit_label', 32);
      t.string('currency', 3).notNullable().defaultTo('CHF');
      t.bigInteger('amount_minor');
      t.decimal('percent', 7, 2);
      t.decimal('included_units', 10, 2);
      t.decimal('step_size', 10, 2);
      t.decimal('min_value', 10, 2);
      t.decimal('max_value', 10, 2);
      t.string('default_value', 64);
      t.boolean('client_visible').notNullable().defaultTo(true);
      t.integer('display_order').notNullable().defaultTo(0);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['is_active']);
    });
  }

  if (!(await knex.schema.hasTable('pricing_factor_options'))) {
    await knex.schema.createTable('pricing_factor_options', (t) => {
      t.increments('id').primary();
      t.integer('factor_id').unsigned().notNullable()
        .references('id').inTable('pricing_factors').onDelete('CASCADE');
      t.string('label', 128).notNullable();
      t.string('effect', 16).notNullable().defaultTo('fixed'); // fixed | percent
      t.bigInteger('amount_minor');
      t.decimal('percent', 7, 2);
      t.text('postcodes'); // zone only: one entry per line, "80*" = prefix
      t.integer('position').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['factor_id']);
    });
  }

  if (!(await knex.schema.hasTable('quote_preset_factors'))) {
    await knex.schema.createTable('quote_preset_factors', (t) => {
      t.increments('id').primary();
      t.integer('preset_id').unsigned().notNullable()
        .references('id').inTable('quote_line_item_presets').onDelete('CASCADE');
      // RESTRICT: a factor in use is archived, not deleted.
      t.integer('factor_id').unsigned().notNullable()
        .references('id').inTable('pricing_factors').onDelete('RESTRICT');
      t.integer('position').notNullable().defaultTo(0);
      t.unique(['preset_id', 'factor_id']);
      t.index(['factor_id']);
    });
  }

  for (const table of LINE_ITEM_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex.schema.hasColumn(table, 'pricing_factors')) continue;
    await knex.schema.alterTable(table, (t) => t.text('pricing_factors'));
  }
};

exports.down = async function (knex) {
  for (const table of LINE_ITEM_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'pricing_factors'))) continue;
    await knex.schema.alterTable(table, (t) => t.dropColumn('pricing_factors'));
  }
  await knex.schema.dropTableIfExists('quote_preset_factors');
  await knex.schema.dropTableIfExists('pricing_factor_options');
  await knex.schema.dropTableIfExists('pricing_factors');
};
