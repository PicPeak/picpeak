/**
 * Migration 356: every send date SQLite can read becomes the same instant as
 * canonical ISO text ('YYYY-MM-DDTHH:MM:SS.sssZ'): epoch milliseconds and
 * seconds, the editor's zone-less text, and the ISO forms the old update route
 * stored as given ('Z' without milliseconds, more fraction digits, an offset,
 * a lowercase 'z', a date only, a space instead of 'T'). A second run changes
 * nothing, and down() turns the ISO values back into milliseconds.
 *
 * The rows that clear a send date (a passed one on a scheduled invoice, text
 * that is no date) go through the accounting recorder; they are covered in
 * integration/invoiceSendAtShape.test.js, which has its history table.
 */
const knex = require('knex');
const migration = require('../../migrations/core/356_invoice_send_at_iso');

const MS = Date.UTC(2030, 10, 12, 9, 0, 0, 250);
const AT = '2030-11-12T09:00:00.000Z';

describe('migration 356 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('invoices', (t) => {
      t.increments('id').primary();
      t.string('label');
      t.string('status');
      t.timestamp('scheduled_send_at');
    });
    // useNullAsDefault inserts NULL for a missing key, not a column default.
    await db('invoices').insert([
      { label: 'ms', scheduled_send_at: MS },
      { label: 'seconds', scheduled_send_at: Math.floor(MS / 1000) },
      // The column's numeric affinity stores digit-only text as a number.
      { label: 'digits', scheduled_send_at: String(MS) },
      { label: 'editor', scheduled_send_at: '2030-11-12T09:00' },
      { label: 'Z, no milliseconds', scheduled_send_at: '2030-11-12T09:00:00Z' },
      { label: 'Z, no seconds', scheduled_send_at: '2030-11-12T09:00Z' },
      { label: 'six fraction digits', scheduled_send_at: '2030-11-12T09:00:00.123456Z' },
      { label: 'lowercase z', scheduled_send_at: '2030-11-12T09:00:00.000z' },
      { label: 'offset', scheduled_send_at: '2030-11-12T10:00:00+01:00' },
      { label: 'date only', scheduled_send_at: '2030-11-12' },
      { label: 'space', scheduled_send_at: '2030-11-12 09:00:00' },
      { label: 'canonical', scheduled_send_at: AT },
      // Passed, but not a scheduled invoice: converted, never held.
      { label: 'sent, passed', status: 'sent', scheduled_send_at: '2020-01-01T09:00' },
      { label: 'none', scheduled_send_at: null },
    ].map((row) => ({ status: 'scheduled', ...row })));
  });

  afterEach(async () => { await db.destroy(); });

  const rows = async () => (await db('invoices').orderBy('id')
    .select('label', db.raw('typeof(scheduled_send_at) as kind'), 'scheduled_send_at'))
    .map((r) => [r.label, r.kind, r.scheduled_send_at]);

  it('rewrites every readable shape as the same instant in canonical ISO text', async () => {
    await migration.up(db);
    expect(await rows()).toEqual([
      ['ms', 'text', '2030-11-12T09:00:00.250Z'],
      ['seconds', 'text', AT],
      ['digits', 'text', '2030-11-12T09:00:00.250Z'],
      ['editor', 'text', AT],
      ['Z, no milliseconds', 'text', AT],
      ['Z, no seconds', 'text', AT],
      ['six fraction digits', 'text', '2030-11-12T09:00:00.123Z'],
      ['lowercase z', 'text', AT],
      ['offset', 'text', AT],
      ['date only', 'text', '2030-11-12T00:00:00.000Z'],
      ['space', 'text', AT],
      ['canonical', 'text', AT],
      ['sent, passed', 'text', '2020-01-01T09:00:00.000Z'],
      ['none', 'null', null],
    ]);
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
