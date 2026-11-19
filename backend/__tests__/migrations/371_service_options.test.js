/**
 * Migration 371: service options. Existing lines get adds_to_parent = false
 * (their totals keep the replace rule), existing services get no options, a
 * second run is a no-op that keeps a set flag, and down() removes it all.
 */
const knex = require('knex');
const migration = require('../../migrations/core/371_service_options');

describe('migration 371 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('quote_line_item_presets', (t) => {
      t.increments('id').primary();
      t.string('name');
    });
    for (const name of ['quote_line_items', 'invoice_line_items']) {
      await db.schema.createTable(name, (t) => {
        t.increments('id').primary();
        t.text('description');
      });
      await db(name).insert({ description: 'existing' });
    }
    await db('quote_line_item_presets').insert({ name: 'Typ A' });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the columns: no options on services, existing lines replace as before', async () => {
    await migration.up(db);
    expect((await db('quote_line_item_presets').first()).option_preset_ids).toBeNull();
    for (const name of ['quote_line_items', 'invoice_line_items']) {
      expect(Number((await db(name).first()).adds_to_parent)).toBe(0);
      await db(name).insert({ description: 'new' });
      expect(Number((await db(name).where({ description: 'new' }).first()).adds_to_parent)).toBe(0);
    }
  });

  it('keeps a set flag and options on a second run', async () => {
    await migration.up(db);
    await db('invoice_line_items').update({ adds_to_parent: true });
    await db('quote_line_item_presets').update({ option_preset_ids: '[2]' });
    await migration.up(db);
    expect(Number((await db('invoice_line_items').first()).adds_to_parent)).toBe(1);
    expect((await db('quote_line_item_presets').first()).option_preset_ids).toBe('[2]');
  });

  it('down() removes the columns and is safe to repeat', async () => {
    await migration.up(db);
    await migration.down(db);
    const columns = async (table) => Object.keys(await db(table).columnInfo());
    expect(await columns('quote_line_item_presets')).not.toContain('option_preset_ids');
    expect(await columns('invoice_line_items')).not.toContain('adds_to_parent');
    expect(await columns('quote_line_items')).not.toContain('adds_to_parent');
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
