const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/368_guest_download_identity');

jest.setTimeout(120000);

let db; let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
});

afterAll(async () => { if (cleanup) await cleanup(); });

const columns = async () => ({
  guestId: await db.schema.hasColumn('access_logs', 'guest_id'),
  required: await db.schema.hasColumn('event_feedback_settings', 'require_guest_for_download'),
  privacy: await db.schema.hasColumn('event_feedback_settings', 'guest_privacy_text'),
});

test('adds the columns, survives a re-run, and rolls back cleanly', async () => {
  expect(await columns()).toEqual({ guestId: true, required: true, privacy: true });

  // Idempotent.
  await migration.up(db);
  expect(await columns()).toEqual({ guestId: true, required: true, privacy: true });

  await migration.down(db);
  expect(await columns()).toEqual({ guestId: false, required: false, privacy: false });
  // A second rollback finds nothing to drop.
  await migration.down(db);

  await migration.up(db);
  expect(await columns()).toEqual({ guestId: true, required: true, privacy: true });
});

test('existing rows stay anonymous and the setting stays off', async () => {
  const [ev] = await db('events').insert({
    slug: 'mig-368', event_type: 'wedding', event_name: 'Mig 368', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: '/gallery/mig-368/s', expires_at: new Date(Date.now() + 864e5).toISOString(),
    created_at: new Date().toISOString(),
  }).returning('id');
  const eventId = typeof ev === 'object' ? ev.id : ev;
  await db('event_feedback_settings').insert({ event_id: eventId, feedback_enabled: true });
  await db('access_logs').insert({ event_id: eventId, action: 'view' });

  const settings = await db('event_feedback_settings').where({ event_id: eventId }).first();
  expect(Boolean(settings.require_guest_for_download)).toBe(false);
  expect(settings.guest_privacy_text).toBeNull();
  expect((await db('access_logs').where({ event_id: eventId }).first()).guest_id).toBeNull();
});
