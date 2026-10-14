/**
 * A renamed gallery's old slug keeps leading to it (slug_redirects).
 *
 *  - A new gallery whose generated slug equals that old slug used to take it:
 *    the gallery lookup then found the new gallery first, and every
 *    /gallery/<old-slug>/<token> link of the renamed one answered "Invalid
 *    gallery link". Creation and rename now count a live redirect source as
 *    taken.
 *  - Renaming a gallery away from a slug that already had a redirect row
 *    repointed the row but kept the first gallery's event_id, so on PG
 *    deleting that first gallery cascaded the second one's redirect away.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'slug-redirect-test-secret';

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let adminId;
let renameService; let createEvent;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  renameService = require('../../src/services/eventRenameService');
  ({ createEvent } = require('../../src/services/eventCreationService'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(async () => {
  await db('slug_redirects').del();
  await db('event_customer_assignments').del();
  await db('activity_logs').whereNotNull('event_id').del();
  await db('events').del();
});

let seq = 0;
async function insertEvent(eventName, slug) {
  seq += 1;
  const [e] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: eventName,
    event_date: '2026-06-05',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `/gallery/${slug}`,
    share_token: `${seq}`.padStart(32, 'a'),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  }).returning('id');
  return typeof e === 'object' ? e.id : e;
}

const OLD = 'wedding-old-name-2026-06-05';
const NEW = 'wedding-new-name-2026-06-05';

async function renamed(eventId, name) {
  const result = await renameService.renameEvent(eventId, name);
  expect(result).toMatchObject({ success: true });
  return (await db('events').where({ id: eventId }).first()).slug;
}

describe('an old slug stays with the renamed gallery', () => {
  it('a new gallery with the same name gets a suffixed slug', async () => {
    const first = await insertEvent('Old Name', OLD);
    expect(await renamed(first, 'New Name')).toBe(NEW);

    const created = await createEvent({
      event_type: 'wedding',
      event_name: 'Old Name',
      event_date: '2026-06-05',
      customer_name: 'Anna',
      customer_email: 'anna@example.test',
      admin_email: 'admin@example.test',
      password: 'Sunrise-Lake-42',
      is_draft: false,
      expires_at: '2030-07-15T00:00:00.000Z',
    }, { actor: { id: adminId, username: 'tester' } });

    expect(created.slug).toBe(`${OLD}-1`);
    expect(await db('slug_redirects').where({ old_slug: OLD }).first())
      .toMatchObject({ new_slug: NEW, event_id: first });
  });

  it('a rename onto another gallery\'s old slug is refused', async () => {
    const first = await insertEvent('Old Name', OLD);
    await renamed(first, 'New Name');
    const second = await insertEvent('Other', 'wedding-other-2026-06-05');

    const result = await renameService.renameEvent(second, 'Old Name');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already exists/);
  });

  it('the slug is free again once the gallery it redirects to is gone', async () => {
    const first = await insertEvent('Old Name', OLD);
    await renamed(first, 'New Name');
    // SQLite enforces no foreign keys, so the row outlives the gallery.
    await db('events').where({ id: first }).del();
    const second = await insertEvent('Other', 'wedding-other-2026-06-05');

    expect(await renamed(second, 'Old Name')).toBe(OLD);
    expect(await db('slug_redirects').where({ old_slug: OLD }).first()).toBeUndefined();
  });

  it('renaming back to an earlier name leaves no redirect from the live slug', async () => {
    const first = await insertEvent('Old Name', OLD);
    await renamed(first, 'New Name');
    expect(await renamed(first, 'Old Name')).toBe(OLD);

    expect(await db('slug_redirects').where({ old_slug: OLD }).first()).toBeUndefined();
    expect(await db('slug_redirects').where({ old_slug: NEW }).first())
      .toMatchObject({ new_slug: OLD, event_id: first });
  });
});

describe('a reused redirect row moves to the renaming gallery', () => {
  it('sets event_id along with new_slug', async () => {
    // The state the creation path could leave before this fix: gallery 2
    // holds the slug gallery 1's redirect starts from.
    const first = await insertEvent('New Name', NEW);
    await db('slug_redirects').insert({ old_slug: OLD, new_slug: NEW, event_id: first });
    const second = await insertEvent('Old Name', OLD);

    const target = await renamed(second, 'Third Name');
    expect(await db('slug_redirects').where({ old_slug: OLD }).first())
      .toMatchObject({ new_slug: target, event_id: second });
  });
});
