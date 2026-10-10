/**
 * Migration 280: an install that has sent documents keeps black PDF
 * headings now that they follow the brand accent; a fresh one does not.
 */
const knex = require('knex');
const migration = require('../../migrations/core/280_pdf_accent_keeps_black');

describe('migration 280 on SQLite', () => {
  let db;
  const defaultSettings = async () => {
    const row = await db('pdf_themes').where({ scope: 'default' }).first();
    return row ? JSON.parse(row.settings) : null;
  };

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('pdf_themes', (t) => {
      t.increments('id').primary();
      t.string('scope', 16).notNullable().unique();
      t.text('settings').notNullable();
      t.integer('updated_by_admin_id');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
    await db.schema.createTable('invoices', (t) => { t.increments('id').primary(); });
  });

  afterEach(async () => { await db.destroy(); });

  it('leaves a fresh install to follow the brand', async () => {
    await migration.up(db);
    expect(await defaultSettings()).toBeNull();
  });

  it('pins black on an install with documents, keeping its other settings, and runs again', async () => {
    await db('invoices').insert({});
    await db('pdf_themes').insert({ scope: 'default', settings: JSON.stringify({ titleSize: 22, colors: { text: '#111111' } }) });
    await migration.up(db);
    expect(await defaultSettings()).toEqual({ titleSize: 22, colors: { text: '#111111', accent: '#000000' } });
    await migration.up(db);
    expect(await defaultSettings()).toEqual({ titleSize: 22, colors: { text: '#111111', accent: '#000000' } });
  });

  it('keeps an accent the admin already chose', async () => {
    await db('invoices').insert({});
    await db('pdf_themes').insert({ scope: 'default', settings: JSON.stringify({ colors: { accent: '#123456' } }) });
    await migration.up(db);
    expect((await defaultSettings()).colors.accent).toBe('#123456');
  });

  it('creates the row when an install with documents never saved a PDF theme', async () => {
    await db('invoices').insert({});
    await migration.up(db);
    expect(await defaultSettings()).toEqual({ colors: { accent: '#000000' } });
  });

  it('stores the timestamps as ISO strings', async () => {
    await db('invoices').insert({});
    await migration.up(db);
    const row = await db('pdf_themes').where({ scope: 'default' }).first('created_at', 'updated_at');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
