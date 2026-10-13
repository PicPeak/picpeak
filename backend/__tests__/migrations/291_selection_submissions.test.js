/**
 * Migration 291: selection_submissions and the per-gallery switch (issue
 * 1733, A1). Guarded, so a second run is a no-op; the partial unique index
 * allows one ACTIVE submission per (event, guest, kind) and any number of
 * reopened ones; down() removes exactly what up() added.
 */
const knex = require('knex');
const migration = require('../../migrations/core/291_selection_submissions');

describe('migration 291 on SQLite', () => {
  let db;
  const row = (patch = {}) => ({
    event_id: 1, guest_identifier: 'guest-a', kind: 'selection', item_count: 3,
    submitted_at: new Date().toISOString(), ...patch,
  });

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => { t.increments('id').primary(); });
    await db.schema.createTable('gallery_guests', (t) => { t.increments('id').primary(); });
    await db.schema.createTable('admin_users', (t) => { t.increments('id').primary(); });
    await db.schema.createTable('event_feedback_settings', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
    });
  });

  afterEach(async () => { await db.destroy(); });

  it('creates the table and the switch, and runs again without complaint', async () => {
    await migration.up(db);
    expect(await db.schema.hasTable('selection_submissions')).toBe(true);
    expect(await db.schema.hasColumn('event_feedback_settings', 'allow_selection_submit')).toBe(true);
    await expect(migration.up(db)).resolves.toBeUndefined();

    // Off for the galleries that already exist.
    await db('event_feedback_settings').insert({ event_id: 1 });
    expect((await db('event_feedback_settings').first()).allow_selection_submit).toBe(0);
  });

  it('allows one active submission per event, guest and kind', async () => {
    await migration.up(db);
    await db('selection_submissions').insert(row());
    await expect(db('selection_submissions').insert(row())).rejects.toThrow(/UNIQUE/i);

    // Another kind, another guest and another gallery are separate.
    await db('selection_submissions').insert(row({ kind: 'approval' }));
    await db('selection_submissions').insert(row({ guest_identifier: 'guest-b' }));
    await db('selection_submissions').insert(row({ event_id: 2 }));

    // Reopened, the guest submits again and the first row stays as history.
    await db('selection_submissions').where({ event_id: 1, guest_identifier: 'guest-a', kind: 'selection' })
      .update({ reopened_at: new Date().toISOString() });
    await db('selection_submissions').insert(row());
    expect(await db('selection_submissions').where({ event_id: 1, guest_identifier: 'guest-a', kind: 'selection' }))
      .toHaveLength(2);
  });

  it('down() removes both, and is a no-op without them', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasTable('selection_submissions')).toBe(false);
    expect(await db.schema.hasColumn('event_feedback_settings', 'allow_selection_submit')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
  });

  it('does nothing without an events table', async () => {
    await db.schema.dropTable('events');
    await db.schema.dropTable('event_feedback_settings');
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db.schema.hasTable('selection_submissions')).toBe(false);
  });
});
