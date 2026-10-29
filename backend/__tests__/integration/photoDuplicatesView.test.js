/**
 * The duplicates view (issue 2194): groups of photos in one gallery that share
 * a content hash, and "keep one, move the rest to the trash".
 *
 * Pins the contract:
 *  - a group is two or more live photos of THIS gallery with one hash; rows
 *    without a hash and photos in the trash take no part, and the same bytes
 *    in another gallery never join a group
 *  - each group lists its photos oldest upload first; the groups page
 *  - resolve keeps the named photo and trashes the others of its group, and
 *    only those: a trash entry like a manual delete, restorable through the
 *    trash route, announced by photo.deleted and the activity log
 *  - with the trash off nothing is deleted
 *  - the routes are scoped to the gallery and its permissions like delete is
 */
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(24).toString('hex');

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

jest.mock('../../src/services/downloadZipService', () => ({ invalidate: jest.fn() }));

describe('duplicates view (issue 2194)', () => {
  let db; let cleanup; let app; let webhookFire;
  const tok = {};
  const id = {};
  let seq = 0;

  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);
  const firstId = (rows) => rows[0]?.id ?? rows[0];
  const hash = (label) => crypto.createHash('sha256').update(label).digest('hex');
  const iso = (minutes) => new Date(Date.UTC(2026, 9, 1, 10, minutes)).toISOString();

  async function mkAdmin(name, roleName) {
    const adminId = firstId(await db('admin_users').insert({
      username: `dupview-${name}`, email: `dupview-${name}@example.com`, password_hash: 'x',
      must_change_password: false, created_at: new Date().toISOString(),
    }).returning('id'));
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }

  async function mkEvent(createdBy = id.owner) {
    seq += 1;
    const slug = `dupview-event-${seq}`;
    const eventId = firstId(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Dup view ${seq}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/t`, share_token: crypto.randomBytes(8).toString('hex'),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: createdBy, created_at: new Date().toISOString(),
    }).returning('id'));
    return db('events').where({ id: eventId }).first();
  }

  async function mkPhoto(event, fields = {}) {
    seq += 1;
    const filename = `IMG_${seq}.jpg`;
    return firstId(await db('photos').insert({
      event_id: event.id, filename, original_filename: `Original ${seq}.jpg`, path: `${event.slug}/${filename}`,
      type: 'individual', media_type: 'image', mime_type: 'image/jpeg', size_bytes: 1000 + seq,
      uploaded_at: iso(seq), processing_status: 'complete', visibility: 'visible',
      ...fields,
    }).returning('id'));
  }

  const setRetention = async (days) => {
    await db('app_settings').where({ setting_key: 'general_photo_trash_retention_days' }).del();
    if (days !== undefined) {
      await db('app_settings').insert({
        setting_key: 'general_photo_trash_retention_days', setting_value: JSON.stringify(days), setting_type: 'general',
      });
    }
  };

  const base = (event) => `/api/admin/events/${event.id}/photos`;
  const groups = (event, who = 'owner', query = '') => as(request(app).get(`${base(event)}/duplicates${query}`), who);
  const resolve = (event, keepIds, who = 'owner') => as(request(app).post(`${base(event)}/duplicates/resolve`), who).send({ keepIds });
  const live = async (photoId) => (await db('photos').where({ id: photoId }).first())?.deleted_at == null;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    id.owner = await mkAdmin('owner', 'solo_photographer');
    id.other = await mkAdmin('other', 'solo_photographer');
    id.viewer = await mkAdmin('viewer', 'viewer');
    webhookFire = jest.spyOn(require('../../src/services/webhookService'), 'fire').mockResolvedValue();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminPhotos'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => { await setRetention(undefined); webhookFire.mockClear(); });

  it('groups only this gallery\'s live, hashed photos with the same bytes, oldest first', async () => {
    const event = await mkEvent();
    const elsewhere = await mkEvent();
    // Inserted newest first, so the order is the upload date's, not the id's.
    const newer = await mkPhoto(event, { content_sha256: hash('a'), uploaded_at: iso(50) });
    const older = await mkPhoto(event, { content_sha256: hash('a'), uploaded_at: iso(5), uploaded_by: 'guest' });
    await mkPhoto(event, { content_sha256: hash('b') }); // unique
    await mkPhoto(event); await mkPhoto(event); // no hash: never compared
    const trashed = await mkPhoto(event, { content_sha256: hash('c') });
    await mkPhoto(event, { content_sha256: hash('c') });
    await db('photos').where({ id: trashed }).update({ deleted_at: new Date().toISOString(), purge_after: new Date().toISOString() });
    // The same bytes in another gallery do not make a group here.
    await mkPhoto(elsewhere, { content_sha256: hash('b') });
    await mkPhoto(elsewhere, { content_sha256: hash('a') });

    const res = await groups(event);
    expect(res.status).toBe(200);
    expect(res.body.total_groups).toBe(1);
    expect(res.body.total_photos).toBe(2);
    expect(res.body.groups).toHaveLength(1);
    const [group] = res.body.groups;
    expect(group.content_sha256).toBe(hash('a'));
    expect(group.photos.map((p) => p.id)).toEqual([older, newer]);
    expect(group.photos[0]).toMatchObject({
      filename: expect.stringMatching(/^Original \d+\.jpg$/),
      uploaded_at: iso(5),
      size: expect.any(Number),
      source: 'guest',
      thumbnail_url: `/admin/photos/${event.id}/thumbnail/${older}`,
    });
    expect(group.photos[1].source).toBe('admin');
  });

  it('reads SQLite\'s zone-less upload time as UTC when picking the oldest', async () => {
    // 11:00 UTC from the database default, after 10:00Z written by the API.
    // Read in the server's zone (Berlin), the zone-less one would come first.
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      const event = await mkEvent();
      const later = await mkPhoto(event, { content_sha256: hash('tz'), uploaded_at: '2026-10-01 11:00:00' });
      const earlier = await mkPhoto(event, { content_sha256: hash('tz'), uploaded_at: '2026-10-01T10:00:00.000Z' });
      const res = await groups(event);
      expect(res.body.groups[0].photos.map((p) => p.id)).toEqual([earlier, later]);
      expect(res.body.groups[0].photos.map((p) => p.uploaded_at)).toEqual(['2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z']);
    } finally {
      if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
    }
  });

  it('answers an empty list for a gallery without duplicates', async () => {
    const event = await mkEvent();
    await mkPhoto(event, { content_sha256: hash('only') });
    await mkPhoto(event);
    const res = await groups(event);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ groups: [], total_groups: 0, total_photos: 0 });
  });

  it('pages the groups, the earliest group first', async () => {
    const event = await mkEvent();
    for (const label of ['p1', 'p2', 'p3']) {
      await mkPhoto(event, { content_sha256: hash(label) });
      await mkPhoto(event, { content_sha256: hash(label) });
    }
    const first = await groups(event, 'owner', '?limit=2');
    expect(first.body.total_groups).toBe(3);
    expect(first.body.groups.map((g) => g.content_sha256)).toEqual([hash('p1'), hash('p2')]);
    const second = await groups(event, 'owner', '?limit=2&offset=2');
    expect(second.body.groups.map((g) => g.content_sha256)).toEqual([hash('p3')]);
  });

  it('keeps the chosen photo and moves the rest of its group to the trash, restorably', async () => {
    const event = await mkEvent();
    const a1 = await mkPhoto(event, { content_sha256: hash('r') });
    const a2 = await mkPhoto(event, { content_sha256: hash('r') });
    const a3 = await mkPhoto(event, { content_sha256: hash('r') });
    const unrelated = await mkPhoto(event, { content_sha256: hash('s') });
    const noHash = await mkPhoto(event);

    const res = await resolve(event, [a2]);
    expect(res.status).toBe(200);
    expect(res.body.trashed).toBe(2);
    expect(res.body.photo_ids.sort()).toEqual([a1, a3].sort());
    expect(await live(a2)).toBe(true);
    expect(await live(a1)).toBe(false);
    expect(await live(a3)).toBe(false);
    expect(await live(unrelated)).toBe(true);
    expect(await live(noHash)).toBe(true);

    // In the trash like a manual delete: listed, by whom, and restorable.
    const trash = await as(request(app).get(`${base(event)}/trash`), 'owner');
    expect(trash.body.items.map((i) => i.id).sort()).toEqual([a1, a3].sort());
    expect(trash.body.items[0].deleted_by_name).toBe('dupview-owner');
    expect(webhookFire).toHaveBeenCalledTimes(2);
    expect(webhookFire).toHaveBeenCalledWith('photo.deleted', expect.objectContaining({ photo: expect.objectContaining({ id: a1 }) }));
    const activity = await db('activity_logs').where({ event_id: event.id, activity_type: 'photos_bulk_deleted' });
    expect(activity).toHaveLength(1);

    const restored = await as(request(app).post(`${base(event)}/trash/restore`), 'owner').send({ ids: [a1, a3] });
    expect(restored.status).toBe(200);
    expect(await live(a1)).toBe(true);
    expect((await groups(event)).body.groups[0].photos.map((p) => p.id)).toEqual([a1, a2, a3]);
  });

  it('two admins keeping different copies of one group at once leave one copy live', async () => {
    // Both requests read their kept photo before either trashes anything; the
    // second must not trash the first one's keep because of its stale read.
    const event = await mkEvent();
    const a = await mkPhoto(event, { content_sha256: hash('race') });
    const b = await mkPhoto(event, { content_sha256: hash('race') });

    const [first, second] = await Promise.all([resolve(event, [a]), resolve(event, [b])]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const alive = [await live(a), await live(b)].filter(Boolean);
    expect(alive).toHaveLength(1);
    expect(first.body.trashed + second.body.trashed).toBe(1);
  });

  it('resolves several groups in one request, and refuses two keeps of one group', async () => {
    const event = await mkEvent();
    const x1 = await mkPhoto(event, { content_sha256: hash('x') });
    const x2 = await mkPhoto(event, { content_sha256: hash('x') });
    const y1 = await mkPhoto(event, { content_sha256: hash('y') });
    const y2 = await mkPhoto(event, { content_sha256: hash('y') });

    const same = await resolve(event, [x1, x2]);
    expect(same.status).toBe(400);
    expect(await live(x1)).toBe(true);
    expect(await live(x2)).toBe(true);

    const res = await resolve(event, [x1, y1]);
    expect(res.body.trashed).toBe(2);
    expect(await live(x2)).toBe(false);
    expect(await live(y2)).toBe(false);
    expect((await groups(event)).body.total_groups).toBe(0);
  });

  it('a kept photo of another gallery trashes nothing in either', async () => {
    const event = await mkEvent();
    const elsewhere = await mkEvent();
    const here = await mkPhoto(event, { content_sha256: hash('cross') });
    const there1 = await mkPhoto(elsewhere, { content_sha256: hash('cross') });
    const there2 = await mkPhoto(elsewhere, { content_sha256: hash('cross') });
    const res = await resolve(event, [there1]);
    expect(res.status).toBe(200);
    expect(res.body.trashed).toBe(0);
    expect(await live(here)).toBe(true);
    expect(await live(there2)).toBe(true);
  });

  it('with the trash turned off deletes nothing', async () => {
    await setRetention(0);
    const event = await mkEvent();
    const k = await mkPhoto(event, { content_sha256: hash('off') });
    const d = await mkPhoto(event, { content_sha256: hash('off') });
    const res = await resolve(event, [k]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRASH_OFF');
    expect(await db('photos').where({ id: d }).first()).toMatchObject({ deleted_at: null });
  });

  it('is scoped to the gallery and its permissions like delete is', async () => {
    const event = await mkEvent();
    const k = await mkPhoto(event, { content_sha256: hash('perm') });
    const d = await mkPhoto(event, { content_sha256: hash('perm') });

    // Another photographer's gallery.
    expect((await groups(event, 'other')).status).toBe(403);
    expect((await resolve(event, [k], 'other')).status).toBe(403);
    expect(await live(d)).toBe(true);
    // A viewer may look at their own gallery's duplicates, not delete them.
    const viewed = await mkEvent(id.viewer);
    const v1 = await mkPhoto(viewed, { content_sha256: hash('view') });
    const v2 = await mkPhoto(viewed, { content_sha256: hash('view') });
    expect((await groups(viewed, 'viewer')).status).toBe(200);
    expect((await resolve(viewed, [v1], 'viewer')).status).toBe(403);
    expect(await live(v2)).toBe(true);
    // No token.
    expect((await request(app).get(`${base(event)}/duplicates`)).status).toBe(401);
  });
});
