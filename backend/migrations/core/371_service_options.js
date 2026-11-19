'use strict';
/**
 * Migration 371: options on catalogue services, booked as sub-lines.
 *
 *   quote_line_item_presets.option_preset_ids  JSON array of other catalogue
 *                                              items offered as options of
 *                                              this one (e.g. an online
 *                                              gallery under every shoot
 *                                              type). NULL or [] = none.
 *   quote_line_items.adds_to_parent            A sub-line that adds its
 *   invoice_line_items.adds_to_parent          amount to the parent's own
 *                                              price instead of replacing
 *                                              it, as priced sub-lines do.
 *                                              Ticking an option in the
 *                                              editor makes one.
 *
 * Additive. Every existing line gets false, so every existing document keeps
 * its totals; every existing service gets no options.
 */
const LINE_ITEM_TABLES = ['quote_line_items', 'invoice_line_items'];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('quote_line_item_presets')
    && !(await knex.schema.hasColumn('quote_line_item_presets', 'option_preset_ids'))) {
    await knex.schema.alterTable('quote_line_item_presets', (table) => {
      table.text('option_preset_ids').nullable();
    });
  }
  for (const name of LINE_ITEM_TABLES) {
    if (await knex.schema.hasTable(name) && !(await knex.schema.hasColumn(name, 'adds_to_parent'))) {
      await knex.schema.alterTable(name, (table) => {
        table.boolean('adds_to_parent').notNullable().defaultTo(false);
      });
    }
  }
};

exports.down = async function down(knex) {
  for (const name of LINE_ITEM_TABLES) {
    if (await knex.schema.hasTable(name) && await knex.schema.hasColumn(name, 'adds_to_parent')) {
      await knex.schema.alterTable(name, (table) => {
        table.dropColumn('adds_to_parent');
      });
    }
  }
  if (await knex.schema.hasTable('quote_line_item_presets')
    && await knex.schema.hasColumn('quote_line_item_presets', 'option_preset_ids')) {
    await knex.schema.alterTable('quote_line_item_presets', (table) => {
      table.dropColumn('option_preset_ids');
    });
  }
};
