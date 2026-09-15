/**
 * Migration 215: quote templates, service catalogue, hour/day pricing and
 * discount promotions (#1451).
 *
 * Line items (quote_line_items AND invoice_line_items, so a quote line
 * clones onto an invoice without losing anything):
 *   line_kind          'item' | 'discount'. A discount line is stored as a
 *                      resolved negative amount (qty 1, negative unit price),
 *                      so every existing "sum the top-level lines" loop —
 *                      storno, installments, monthly drafts — stays correct.
 *   unit               hour | day | piece | km | flat (display only)
 *   is_optional        optional add-on the customer can tick (quotes only;
 *   selected           unselected add-ons are left out of totals, the PDF body
 *                      and conversion; sub-items follow their parent)
 *   price_mode         fixed | hour | day
 *   rate_source        where the unit price came from: item | customer |
 *                      default | manual. The rate is copied into
 *                      unit_price_minor, so a later rate change never alters
 *                      an existing document.
 *   bound_to           hours | days — quantity follows the quote-wide value
 *   promotion_snapshot JSON copy of the promotion a discount line came from
 *
 * The existing quote_line_item_presets table is extended in place into the
 * service catalogue, so the current preset picker and routes keep working
 * with no data change (existing rows become fixed-price items).
 *
 * New tables: quote_packages (+ items), quote_promotions, quote_text_blocks,
 * quote_templates and quote_template_versions (immutable published snapshots).
 *
 * Additive and idempotent: every step is guarded, no existing row changes
 * meaning.
 */

const LINE_ITEM_TABLES = ['quote_line_items', 'invoice_line_items'];

async function addColumn(knex, table, column, build) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, (t) => build(t));
}

async function dropColumn(knex, table, column) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, column))) return;
  await knex.schema.alterTable(table, (t) => t.dropColumn(column));
}

exports.up = async function (knex) {
  for (const table of LINE_ITEM_TABLES) {
    await addColumn(knex, table, 'line_kind', (t) => t.string('line_kind', 16).notNullable().defaultTo('item'));
    await addColumn(knex, table, 'unit', (t) => t.string('unit', 16));
    await addColumn(knex, table, 'is_optional', (t) => t.boolean('is_optional').notNullable().defaultTo(false));
    await addColumn(knex, table, 'selected', (t) => t.boolean('selected').notNullable().defaultTo(true));
    await addColumn(knex, table, 'price_mode', (t) => t.string('price_mode', 8));
    await addColumn(knex, table, 'rate_source', (t) => t.string('rate_source', 16));
    await addColumn(knex, table, 'bound_to', (t) => t.string('bound_to', 8));
    await addColumn(knex, table, 'promotion_snapshot', (t) => t.text('promotion_snapshot'));
  }

  // Service catalogue = the existing presets, extended in place.
  await addColumn(knex, 'quote_line_item_presets', 'unit', (t) => t.string('unit', 16));
  await addColumn(knex, 'quote_line_item_presets', 'details_text', (t) => t.text('details_text'));
  await addColumn(knex, 'quote_line_item_presets', 'category', (t) => t.string('category', 64));
  await addColumn(knex, 'quote_line_item_presets', 'vat_code', (t) => t.string('vat_code', 16));
  await addColumn(knex, 'quote_line_item_presets', 'price_mode', (t) => t.string('price_mode', 8).notNullable().defaultTo('fixed'));
  // Pinned rate for per-hour / per-day items ("Second shooter 90 CHF/h");
  // NULL = use the customer's or the business default rate.
  await addColumn(knex, 'quote_line_item_presets', 'pinned_rate_minor', (t) => t.bigInteger('pinned_rate_minor'));

  // Day rate alongside the existing hourly rate chain
  // (customer → business profile, migration 113).
  await addColumn(knex, 'business_profile', 'default_day_rate_minor', (t) => t.bigInteger('default_day_rate_minor'));
  await addColumn(knex, 'customer_accounts', 'day_rate_minor', (t) => t.bigInteger('day_rate_minor'));

  await addColumn(knex, 'quotes', 'source_template_id', (t) => t.integer('source_template_id'));
  await addColumn(knex, 'quotes', 'source_template_version', (t) => t.integer('source_template_version'));
  await addColumn(knex, 'quotes', 'hours', (t) => t.decimal('hours', 10, 2));
  await addColumn(knex, 'quotes', 'days', (t) => t.decimal('days', 10, 2));
  // Add-on selection the customer accepted (phase 2), frozen at acceptance.
  await addColumn(knex, 'quotes', 'optional_selection_snapshot', (t) => t.text('optional_selection_snapshot'));
  await addColumn(knex, 'quotes', 'selection_accepted_at', (t) => t.timestamp('selection_accepted_at'));

  if (!(await knex.schema.hasTable('quote_packages'))) {
    await knex.schema.createTable('quote_packages', (t) => {
      t.increments('id').primary();
      t.string('name', 128).notNullable();
      t.text('description');
      t.string('currency', 3).notNullable().defaultTo('CHF');
      t.integer('display_order').notNullable().defaultTo(0);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['is_active']);
    });
  }

  if (!(await knex.schema.hasTable('quote_package_items'))) {
    await knex.schema.createTable('quote_package_items', (t) => {
      t.increments('id').primary();
      t.integer('package_id').unsigned().notNullable()
        .references('id').inTable('quote_packages').onDelete('CASCADE');
      // RESTRICT: a catalogue item used in a package is archived, not deleted.
      t.integer('preset_id').unsigned().notNullable()
        .references('id').inTable('quote_line_item_presets').onDelete('RESTRICT');
      t.decimal('quantity', 10, 2); // NULL = the catalogue item's default quantity
      t.string('bound_to', 8); // hours | days — follows the quote-wide value
      t.integer('position').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['package_id']);
      t.index(['preset_id']);
    });
  }

  if (!(await knex.schema.hasTable('quote_promotions'))) {
    await knex.schema.createTable('quote_promotions', (t) => {
      t.increments('id').primary();
      t.string('name', 128).notNullable();
      t.text('description');
      t.string('type', 8).notNullable(); // 'fixed' | 'percent'
      t.bigInteger('value_minor'); // fixed amount, in `currency`
      t.string('currency', 3); // fixed only
      t.decimal('percent', 5, 2); // percent only
      t.date('valid_from');
      t.date('valid_until');
      t.integer('display_order').notNullable().defaultTo(0);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['is_active']);
    });
  }

  if (!(await knex.schema.hasTable('quote_text_blocks'))) {
    await knex.schema.createTable('quote_text_blocks', (t) => {
      t.increments('id').primary();
      t.string('kind', 16).notNullable(); // intro | scope | note | closing | terms
      t.string('language', 8).notNullable().defaultTo('de');
      t.string('name', 128).notNullable();
      t.text('body').notNullable();
      t.integer('display_order').notNullable().defaultTo(0);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['kind', 'is_active']);
    });
  }

  if (!(await knex.schema.hasTable('quote_templates'))) {
    await knex.schema.createTable('quote_templates', (t) => {
      t.increments('id').primary();
      t.string('name', 128).notNullable();
      t.text('description');
      t.string('event_type', 64);
      t.string('language', 8);
      t.string('currency', 3);
      t.string('status', 16).notNullable().defaultTo('draft'); // draft | published | archived
      // Working copy the editor saves into; publishing freezes it into a
      // quote_template_versions row.
      t.text('draft_snapshot');
      t.integer('current_version');
      t.integer('created_by_admin_id');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['status']);
    });
  }

  if (!(await knex.schema.hasTable('quote_template_versions'))) {
    await knex.schema.createTable('quote_template_versions', (t) => {
      t.increments('id').primary();
      t.integer('template_id').unsigned().notNullable()
        .references('id').inTable('quote_templates').onDelete('CASCADE');
      t.integer('version').notNullable();
      // Immutable, fully resolved copy (catalogue items, texts, defaults), so
      // later catalogue edits never change what a published version creates.
      t.text('snapshot').notNullable();
      t.timestamp('published_at').defaultTo(knex.fn.now());
      t.integer('published_by_admin_id');
      t.unique(['template_id', 'version']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('quote_template_versions');
  await knex.schema.dropTableIfExists('quote_templates');
  await knex.schema.dropTableIfExists('quote_text_blocks');
  await knex.schema.dropTableIfExists('quote_promotions');
  await knex.schema.dropTableIfExists('quote_package_items');
  await knex.schema.dropTableIfExists('quote_packages');

  for (const column of ['selection_accepted_at', 'optional_selection_snapshot', 'days', 'hours',
    'source_template_version', 'source_template_id']) {
    await dropColumn(knex, 'quotes', column);
  }
  await dropColumn(knex, 'customer_accounts', 'day_rate_minor');
  await dropColumn(knex, 'business_profile', 'default_day_rate_minor');
  for (const column of ['pinned_rate_minor', 'price_mode', 'vat_code', 'category', 'details_text', 'unit']) {
    await dropColumn(knex, 'quote_line_item_presets', column);
  }
  for (const table of LINE_ITEM_TABLES) {
    for (const column of ['promotion_snapshot', 'bound_to', 'rate_source', 'price_mode', 'selected',
      'is_optional', 'unit', 'line_kind']) {
      await dropColumn(knex, table, column);
    }
  }
};
