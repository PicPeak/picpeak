/**
 * Migration 379: block-based website builder (issue 2618).
 *
 *   - website_documents: the whole public website as one JSON document, one
 *     row per state ('draft' | 'published'). Publishing copies the draft into
 *     the published row inside one transaction, so visitors never see half a
 *     publish.
 *   - website_assets: images (and hero videos) uploaded in the builder. Only
 *     the renditions are kept; the uploaded original is not stored.
 *   - events.show_on_website: the explicit per-gallery opt-in. Photos of a
 *     gallery without it never reach the public website.
 *   - feature flag `websiteBuilder`, default off: while off, `/` is the
 *     single-page public site exactly as before.
 *
 * Idempotent: every table and column is guarded, the flag row is inserted
 * only when missing.
 */
const { formatBoolean } = require('../../src/utils/dbCompat');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('website_documents'))) {
    await knex.schema.createTable('website_documents', (t) => {
      t.increments('id').primary();
      t.string('state', 16).notNullable().unique();
      t.text('document').notNullable();
      t.integer('revision').notNullable().defaultTo(1);
      t.integer('updated_by');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.timestamp('published_at');
    });
  }

  if (!(await knex.schema.hasTable('website_assets'))) {
    await knex.schema.createTable('website_assets', (t) => {
      t.increments('id').primary();
      t.string('public_id', 32).notNullable().unique();
      t.string('kind', 16).notNullable().defaultTo('image');
      t.string('mime_type', 64);
      t.integer('width');
      t.integer('height');
      // JSON: { "640": key, "1280": key, "1920": key } for images,
      // { "video": key } for a hero video.
      t.text('rendition_keys').notNullable();
      t.string('original_filename', 255);
      t.bigInteger('size_bytes');
      t.integer('created_by');
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }

  if (await knex.schema.hasTable('events') && !(await knex.schema.hasColumn('events', 'show_on_website'))) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('show_on_website').notNullable().defaultTo(false);
    });
  }

  if (await knex.schema.hasTable('feature_flags')) {
    const flag = await knex('feature_flags').where({ key: 'websiteBuilder' }).first();
    if (!flag) await knex('feature_flags').insert({ key: 'websiteBuilder', value: formatBoolean(false) });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'websiteBuilder' }).del();
  }
  if (await knex.schema.hasTable('events') && await knex.schema.hasColumn('events', 'show_on_website')) {
    await knex.schema.alterTable('events', (t) => t.dropColumn('show_on_website'));
  }
  await knex.schema.dropTableIfExists('website_assets');
  await knex.schema.dropTableIfExists('website_documents');
};
