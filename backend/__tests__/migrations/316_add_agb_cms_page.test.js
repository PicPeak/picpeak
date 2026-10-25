/**
 * Migration 316 adds the AGB page HIDDEN: a placeholder terms page nobody
 * wrote must not appear in every install's footers. It also hides the row the
 * db.js seed wrote on a fresh database (the seed runs before migration 089
 * adds show_in_footer with default true), but never touches a page the
 * operator has already written.
 */
const knex = require('knex');
const migration = require('../../migrations/core/316_add_agb_cms_page');

const PLACEHOLDER_EN = '<h2>Terms & Conditions</h2><p>Please edit this content in the admin panel.</p>';
const PLACEHOLDER_DE = '<h2>AGB</h2><p>Bitte bearbeiten Sie diesen Inhalt im Admin-Panel.</p>';

let db;
beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('cms_pages', (table) => {
    table.increments('id').primary();
    table.string('slug', 100).unique().notNullable();
    table.text('title_en');
    table.text('title_de');
    table.text('content_en');
    table.text('content_de');
    table.boolean('show_in_footer').notNullable().defaultTo(true);
    table.timestamp('updated_at');
  });
});
afterEach(async () => { await db.destroy(); });

const agb = () => db('cms_pages').where('slug', 'agb').first();

test('adds the page hidden from the footers', async () => {
  await migration.up(db);
  const row = await agb();
  expect(row).toMatchObject({ title_en: 'Terms & Conditions', title_de: 'AGB', show_in_footer: 0 });
  expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('hides the placeholder row a fresh database got from the seed', async () => {
  await db('cms_pages').insert({ slug: 'agb', content_en: PLACEHOLDER_EN, content_de: PLACEHOLDER_DE });
  await migration.up(db);
  expect((await agb()).show_in_footer).toBe(0);
});

test('leaves a page the operator already wrote alone', async () => {
  await db('cms_pages').insert({ slug: 'agb', content_en: '<p>Our terms</p>', content_de: '<p>Unsere AGB</p>', show_in_footer: true });
  await migration.up(db);
  const row = await agb();
  expect(row).toMatchObject({ content_en: '<p>Our terms</p>', show_in_footer: 1 });
});

test('is idempotent and down() removes only the AGB row', async () => {
  await db('cms_pages').insert({ slug: 'impressum', content_en: 'x', content_de: 'x' });
  await migration.up(db);
  await migration.up(db);
  expect(await db('cms_pages').where('slug', 'agb').count({ c: '*' }).first()).toEqual({ c: 1 });
  await migration.down(db);
  expect(await db('cms_pages').pluck('slug')).toEqual(['impressum']);
});
