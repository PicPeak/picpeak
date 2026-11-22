const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/373_content_translations');

jest.setTimeout(120000);

let db; let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
});

afterAll(async () => { if (cleanup) await cleanup(); });

const schema = async () => ({
  table: await db.schema.hasTable('content_translations'),
  mode: await db.schema.hasColumn('events', 'text_language_mode'),
  primary: await db.schema.hasColumn('events', 'text_primary_language'),
  secondary: await db.schema.hasColumn('events', 'text_secondary_language'),
});
const all = (value) => ({ table: value, mode: value, primary: value, secondary: value });

test('adds the table and columns, survives a re-run, and rolls back cleanly', async () => {
  expect(await schema()).toEqual(all(true));

  await migration.up(db);
  expect(await schema()).toEqual(all(true));

  await migration.down(db);
  expect(await schema()).toEqual(all(false));
  // A second rollback finds nothing to drop.
  await migration.down(db);

  await migration.up(db);
  await migration.up(db);
  expect(await schema()).toEqual(all(true));
});

test('existing galleries stay off, and one text per entity, field and language', async () => {
  const [ev] = await db('events').insert({
    slug: 'mig-373', event_type: 'wedding', event_name: 'Mig 373', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: '/gallery/mig-373/s', expires_at: new Date(Date.now() + 864e5).toISOString(),
    created_at: new Date().toISOString(),
  }).returning('id');
  const eventId = typeof ev === 'object' ? ev.id : ev;
  const row = await db('events').where({ id: eventId }).first();
  expect(row.text_language_mode).toBe('off');
  expect(row.text_primary_language).toBeNull();
  expect(row.text_secondary_language).toBeNull();

  const text = { event_id: eventId, entity_type: 'event', entity_id: eventId, field: 'event_name', language: 'en', text: 'Mig' };
  await db('content_translations').insert({ ...text, created_at: new Date().toISOString() });
  await expect(db('content_translations').insert(text)).rejects.toThrow();
  await db('content_translations').insert({ ...text, language: 'de' });
  expect(await db('content_translations').where({ event_id: eventId })).toHaveLength(2);
});
