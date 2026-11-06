/**
 * Customer portal dashboard "Recent": new photos and videos in a gallery.
 *
 * recentFor() groups the uploads per gallery and upload day, so a bulk
 * import is one item with its counts, and only lists what came in after the
 * gallery was assigned and what the customer's gallery view would show.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-portal-recent-photos-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('customer portal Recent: photos_added', () => {
  let db;
  let cleanup;
  let customerId;
  let otherCustomerId;
  let recentFor;

  const idOf = (rows) => rows[0]?.id ?? rows[0];
  let seq = 0;
  const event = async (slug, assignedAt, { customer = customerId, ...overrides } = {}) => {
    const id = idOf(await db('events').insert({
      slug, event_type: 'other', event_name: `Event ${slug}`, event_date: '2026-09-01',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      share_link: `${slug}-share`, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      ...overrides,
    }).returning('id'));
    await db('event_customer_assignments').insert({ event_id: id, customer_account_id: customer, assigned_at: assignedAt });
    return id;
  };
  const photos = async (eventId, n, uploadedAt, overrides = {}) => {
    const rows = Array.from({ length: n }, () => {
      seq += 1;
      return {
        event_id: eventId, filename: `p${seq}.jpg`, path: `p${seq}.jpg`, type: 'individual',
        uploaded_at: uploadedAt, ...overrides,
      };
    });
    await db('photos').insert(rows);
  };
  const photosAdded = async (cid = customerId) => (await recentFor(cid, {}, 10))
    .filter((i) => i.kind === 'photos_added');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    otherCustomerId = idOf(await db('customer_accounts').insert({
      email: 'other@example.com', display_name: 'Other', password_hash: 'x', is_active: 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
    ({ recentFor } = require('../../src/services/customerPortalService')._internal);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('photos').del();
    await db('event_customer_assignments').del();
    await db('events').del();
  });

  it('groups a bulk import into one item per gallery and upload day, with photo and video counts', async () => {
    const id = await event('wedding', '2026-10-01T08:00:00.000Z');
    await photos(id, 40, '2026-10-03T09:00:00.000Z');
    await photos(id, 2, '2026-10-03T09:30:00.000Z', { media_type: 'video', mime_type: 'video/mp4' });
    await photos(id, 1, '2026-10-03T10:00:00.000Z', { mime_type: 'video/quicktime' });
    await photos(id, 5, '2026-10-05T12:00:00.000Z');

    expect(await photosAdded()).toEqual([
      {
        kind: 'photos_added', id: `${id}-2026-10-05`, title: 'Event wedding', at: '2026-10-05T12:00:00.000Z',
        link: '/customer/events/wedding', counts: { photos: 5, videos: 0 },
      },
      {
        kind: 'photos_added', id: `${id}-2026-10-03`, title: 'Event wedding', at: '2026-10-03T10:00:00.000Z',
        link: '/customer/events/wedding', counts: { photos: 40, videos: 3 },
      },
    ]);
  });

  it('reads the CURRENT_TIMESTAMP and epoch-ms shapes SQLite may hold', async () => {
    const id = await event('shapes', '2026-10-01 08:00:00');
    await photos(id, 1, '2026-10-02 07:00:00');
    await photos(id, 1, Date.parse('2026-10-02T09:00:00.000Z'));
    const [item] = await photosAdded();
    expect(item).toMatchObject({ id: `${id}-2026-10-02`, at: '2026-10-02T09:00:00.000Z', counts: { photos: 2, videos: 0 } });
  });

  it('leaves out what was uploaded before the gallery was assigned', async () => {
    const id = await event('before', '2026-10-10T08:00:00.000Z');
    await photos(id, 30, '2026-10-09T08:00:00.000Z');
    await photos(id, 3, '2026-10-10T07:59:59.000Z');
    expect(await photosAdded()).toEqual([]);
    await photos(id, 2, '2026-10-10T08:00:01.000Z');
    expect((await photosAdded()).map((i) => i.counts)).toEqual([{ photos: 2, videos: 0 }]);
  });

  it('counts only what the customer\'s gallery view shows', async () => {
    const id = await event('visible', '2026-10-01T08:00:00.000Z');
    await photos(id, 1, '2026-10-02T08:00:00.000Z');
    await photos(id, 1, '2026-10-02T08:00:00.000Z', { visibility: 'hidden' });
    await photos(id, 1, '2026-10-02T08:00:00.000Z', { visibility: 'hidden', moderation_status: 'pending' });
    await photos(id, 1, '2026-10-02T08:00:00.000Z', { deleted_at: '2026-10-03T08:00:00.000Z' });
    await photos(id, 1, '2026-10-02T08:00:00.000Z', { processing_status: 'processing' });
    expect((await photosAdded()).map((i) => i.counts)).toEqual([{ photos: 1, videos: 0 }]);
  });

  it('skips draft galleries and other customers\' galleries', async () => {
    const draft = await event('draft', '2026-10-01T08:00:00.000Z', { is_draft: true });
    await photos(draft, 4, '2026-10-02T08:00:00.000Z');
    const theirs = await event('theirs', '2026-10-01T08:00:00.000Z', { customer: otherCustomerId });
    await photos(theirs, 4, '2026-10-02T08:00:00.000Z');
    expect(await photosAdded()).toEqual([]);
    expect((await photosAdded(otherCustomerId)).map((i) => i.link)).toEqual(['/customer/events/theirs']);
  });

  it('stays out of the feed for a login without the galleries right', async () => {
    const id = await event('norights', '2026-10-01T08:00:00.000Z');
    await photos(id, 3, '2026-10-02T08:00:00.000Z');
    expect(await recentFor(customerId, {}, 10, { galleries: false })).toEqual([]);
  });

  it('keeps one item per group and only as many groups as the feed holds', async () => {
    const id = await event('many', '2026-09-01T08:00:00.000Z');
    for (let d = 1; d <= 12; d += 1) await photos(id, 2, `2026-10-${String(d).padStart(2, '0')}T08:00:00.000Z`);
    const items = await recentFor(customerId, {}, 10);
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({ kind: 'photos_added', id: `${id}-2026-10-12` });
    expect(items.every((i) => i.kind === 'photos_added')).toBe(true);
  });

  it('lists the whole feed on the activity page, past the dashboard\'s ten', async () => {
    const { getActivity, getDashboard } = require('../../src/services/customerPortalService');
    const id = await event('long', '2026-09-01T08:00:00.000Z');
    for (let d = 1; d <= 12; d += 1) await photos(id, 1, `2026-10-${String(d).padStart(2, '0')}T08:00:00.000Z`);
    expect((await getDashboard(customerId)).recent).toHaveLength(10);
    const { items } = await getActivity(customerId);
    // 12 upload days plus "gallery is now available".
    expect(items).toHaveLength(13);
    expect(items[12]).toMatchObject({ kind: 'gallery_assigned', title: 'Event long' });
  });
});
