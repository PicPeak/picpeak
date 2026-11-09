/**
 * Migration 356: send dates SQLite stored as epoch milliseconds, epoch
 * seconds or the editor's zone-less text become ISO UTC text; ISO text and
 * null stay as they are, and text that is no date becomes NULL. A scheduled invoice whose zone-less send date has
 * passed was never sent, and is held as a draft (no send date) instead of
 * going out late. A second run changes nothing, and down() turns the ISO
 * values back into milliseconds.
 */
const knex = require('knex');
const migration = require('../../migrations/core/356_invoice_send_at_iso');

const MS = Date.UTC(2026, 10, 12, 9, 0, 0, 250);

describe('migration 356 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('invoices', (t) => {
      t.increments('id').primary();
      t.string('label');
      t.string('status').defaultTo('scheduled');
      t.timestamp('scheduled_send_at');
    });
    // useNullAsDefault inserts NULL for a missing key, not the column default.
    await db('invoices').insert([
      { label: 'ms', scheduled_send_at: MS },
      { label: 'seconds', scheduled_send_at: Math.floor(MS / 1000) },
      { label: 'editor', scheduled_send_at: '2099-11-12T09:00' },
      { label: 'stuck', scheduled_send_at: '2020-01-01T09:00' },
      { label: 'stuck but sent', status: 'sent', scheduled_send_at: '2020-01-01T09:00' },
      { label: 'iso', scheduled_send_at: '2026-11-12T09:00:00.000Z' },
      { label: 'digits', scheduled_send_at: String(Date.UTC(2026, 10, 12, 9)) },
      { label: 'blank', scheduled_send_at: '' },
      { label: 'not a date', scheduled_send_at: 'next week' },
      { label: 'none', scheduled_send_at: null },
    ].map((row) => ({ status: 'scheduled', ...row })));
  });

  afterEach(async () => { await db.destroy(); });

  const rows = async () => (await db('invoices').orderBy('id')
    .select('label', db.raw('typeof(scheduled_send_at) as kind'), 'scheduled_send_at'))
    .map((r) => [r.label, r.kind, r.scheduled_send_at]);

  it('rewrites numbers and zone-less text as ISO UTC text, holds stuck invoices as drafts, and leaves the rest alone', async () => {
    await migration.up(db);
    expect(await rows()).toEqual([
      ['ms', 'text', '2026-11-12T09:00:00.250Z'],
      ['seconds', 'text', '2026-11-12T09:00:00.000Z'],
      ['editor', 'text', '2099-11-12T09:00:00.000Z'],
      ['stuck', 'null', null],
      ['stuck but sent', 'text', '2020-01-01T09:00:00.000Z'],
      ['iso', 'text', '2026-11-12T09:00:00.000Z'],
      // The column's numeric affinity stores digit-only text as a number.
      ['digits', 'text', '2026-11-12T09:00:00.000Z'],
      ['blank', 'null', null],
      ['not a date', 'null', null],
      ['none', 'null', null],
    ]);
  });

  it('reports how many stuck invoices it held as drafts', async () => {
    const { isoSqliteInvoiceSendAt } = require('../../src/utils/invoiceSendAt');
    expect(await isoSqliteInvoiceSendAt(db)).toBe(1);
    expect(await isoSqliteInvoiceSendAt(db)).toBe(0);
  });

  it('changes nothing on a second run', async () => {
    await migration.up(db);
    const once = await rows();
    await migration.up(db);
    expect(await rows()).toEqual(once);
  });

  it('down() restores milliseconds, and both directions skip a database without invoices', async () => {
    await migration.up(db);
    await migration.down(db);
    expect((await rows())[0]).toEqual(['ms', 'integer', MS]);
    await db.schema.dropTable('invoices');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
