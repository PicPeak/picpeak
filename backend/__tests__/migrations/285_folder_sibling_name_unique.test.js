/**
 * Migration 285 — one folder per name among its siblings.
 *
 *   - existing duplicates (any case) are renamed "Name (2)", "Name (3)", the
 *     oldest keeping its name; no photo, parent or source_path moves
 *   - after up() the database refuses a new duplicate, but not the same name
 *     under another parent, in another event, or on a filter category
 *   - re-running up() changes nothing
 */
const path = require('path'), fs = require('fs'), os = require('os');
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig285-')), 'db.sqlite');
process.env.JWT_SECRET = 'mig';
const { bootCrmDb } = require('../integration/helpers/crmDb');
const mig = require('../../migrations/core/285_folder_sibling_name_unique');

const idOf = (r) => Number(r[0]?.id ?? r[0]);

describe('migration 285', () => {
  let db, cleanup, eventA, eventB;
  let n = 0;

  async function mkEvent(slug) {
    return idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/s`, share_token: slug, expires_at: new Date(Date.now() + 864e5).toISOString(),
      created_at: new Date().toISOString(),
    }).returning('id'));
  }

  async function folder(eventId, name, { parentId = null, isFolder = true, sourcePath = null } = {}) {
    n += 1;
    return idOf(await db('photo_categories').insert({
      name, slug: `s-${n}`, is_global: false, event_id: eventId, is_folder: isFolder,
      parent_id: parentId, source_path: sourcePath, display_order: n,
    }).returning('id'));
  }

  const nameOf = async (id) => (await db('photo_categories').where('id', id).first()).name;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    eventA = await mkEvent('m285a');
    eventB = await mkEvent('m285b');
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('renames existing duplicates deterministically and keeps every photo where it was', async () => {
    await mig.down(db);
    const keep = await folder(eventA, 'Friday', { sourcePath: 'Friday' });
    const dup1 = await folder(eventA, 'friday');
    const dup2 = await folder(eventA, 'FRIDAY');
    // "Friday (2)" already exists as a real folder: the sweep skips to (3).
    const taken = await folder(eventA, 'Friday (2)');
    const child = await folder(eventA, 'Rings', { parentId: dup1 });
    const childDup = await folder(eventA, 'rings', { parentId: dup1 });
    const otherParent = await folder(eventA, 'Friday', { parentId: keep });
    const otherEvent = await folder(eventB, 'Friday');
    const filter = await folder(eventA, 'Friday', { isFolder: false });
    const photo = idOf(await db('photos').insert({
      event_id: eventA, filename: 'p.jpg', path: 'm285a/p.jpg', type: 'individual', folder_id: dup2,
    }).returning('id'));

    await mig.up(db);

    expect(await nameOf(keep)).toBe('Friday');
    expect(await nameOf(dup1)).toBe('friday (3)');
    expect(await nameOf(dup2)).toBe('FRIDAY (4)');
    expect(await nameOf(taken)).toBe('Friday (2)');
    expect(await nameOf(child)).toBe('Rings');
    expect(await nameOf(childDup)).toBe('rings (2)');
    expect(await nameOf(otherParent)).toBe('Friday');
    expect(await nameOf(otherEvent)).toBe('Friday');
    expect(await nameOf(filter)).toBe('Friday');
    expect((await db('photos').where('id', photo).first()).folder_id).toBe(dup2);
    expect(Number((await db('photo_categories').where('id', child).first()).parent_id)).toBe(dup1);
    expect((await db('photo_categories').where('id', keep).first()).source_path).toBe('Friday');
  });

  it('then refuses a new duplicate, but not the same name elsewhere', async () => {
    const parent = await folder(eventA, 'Saturday');
    await expect(folder(eventA, 'SATURDAY')).rejects.toThrow();
    await folder(eventA, 'Saturday', { parentId: parent });
    await folder(eventB, 'Saturday');
    await folder(eventA, 'Saturday', { isFolder: false });
    // A global category is no event folder.
    await db('photo_categories').insert({ name: 'Saturday', slug: 'g-sat', is_global: true, event_id: null, is_folder: true });
    await db('photo_categories').insert({ name: 'saturday', slug: 'g-sat-2', is_global: true, event_id: null, is_folder: true });
  });

  it('is idempotent', async () => {
    const before = await db('photo_categories').orderBy('id').select('id', 'name');
    await mig.up(db);
    expect(await db('photo_categories').orderBy('id').select('id', 'name')).toEqual(before);
  });

  it('cuts a long name so the suffix still fits the 100-character limit', async () => {
    await mig.down(db);
    const long = 'L'.repeat(100);
    await folder(eventB, long);
    const dup = await folder(eventB, long.toLowerCase());
    await mig.up(db);
    const renamed = await nameOf(dup);
    expect(renamed).toHaveLength(100);
    expect(renamed.endsWith(' (2)')).toBe(true);
  });
});
