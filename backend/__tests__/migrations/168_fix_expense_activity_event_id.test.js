/**
 * GHSA-jhcf round 3: scoping the activity feed does nothing about the rows
 * already on disk. expenseService used to pass adminId into logActivity's
 * `eventId` slot, so upgraded instances carry accounting rows whose event_id
 * is an ADMIN id — and the scope predicate happily matches those against a
 * same-numbered event the caller owns.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig168-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mig168-test-secret';

const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/168_fix_expense_activity_event_id');

describe('migration 168 — legacy accounting activity rows (GHSA-jhcf)', () => {
  let db; let cleanup;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('re-attributes the admin id and clears event_id, leaving real rows alone', async () => {
    await db('activity_logs').insert([
      // Legacy shape: event_id is really admin #7, no actor recorded.
      {
        activity_type: 'expense_created',
        actor_type: 'system',
        actor_id: null,
        event_id: 7,
        metadata: JSON.stringify({ expenseId: 1 }),
        created_at: new Date().toISOString(),
      },
      {
        activity_type: 'incoming_invoice_captured',
        actor_type: 'system',
        actor_id: null,
        event_id: 9,
        metadata: JSON.stringify({ inboundDocumentId: 2 }),
        created_at: new Date().toISOString(),
      },
      // A genuine event-scoped row from another subsystem must survive intact.
      {
        activity_type: 'photo_uploaded',
        actor_type: 'admin',
        actor_id: 3,
        event_id: 7,
        metadata: JSON.stringify({}),
        created_at: new Date().toISOString(),
      },
    ]);

    await migration.up(db);

    const expense = await db('activity_logs').where({ activity_type: 'expense_created' }).first();
    expect(expense.event_id == null).toBe(true);
    expect(Number(expense.actor_id)).toBe(7);
    expect(expense.actor_type).toBe('admin');

    const captured = await db('activity_logs').where({ activity_type: 'incoming_invoice_captured' }).first();
    expect(captured.event_id == null).toBe(true);
    expect(Number(captured.actor_id)).toBe(9);

    const photo = await db('activity_logs').where({ activity_type: 'photo_uploaded' }).first();
    expect(Number(photo.event_id)).toBe(7);
    expect(Number(photo.actor_id)).toBe(3);
  });

  it('is idempotent on re-run', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    const expense = await db('activity_logs').where({ activity_type: 'expense_created' }).first();
    expect(Number(expense.actor_id)).toBe(7);
    expect(expense.event_id == null).toBe(true);
  });
});
