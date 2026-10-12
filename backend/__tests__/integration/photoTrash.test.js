/**
 * The photo trash (issue 1733, item D2; migration 294).
 *
 * Pins the contract:
 *  - an admin's delete (single and bulk) moves the row into photo_trash and
 *    the original under trash/, drops the derived files, fires photo.deleted
 *    and leaves no child row behind
 *  - restore gives back the same id, the row, the child rows worth keeping
 *    and the file, and queues processing; faces and download grants are not
 *    kept
 *  - a photo whose id is in use again comes back under a new id, children
 *    with it; one that cannot be restored (cap reached, file missing) stays
 *    in the trash, file included
 *  - the folder watcher neither deletes the row of a file on its way to the
 *    trash nor imports a file a restore is putting back, whichever comes first
 *  - a restore announces nothing: no photo.uploaded, and a photo held for
 *    review comes back held
 *  - forgetting a guest reaches what the trash holds of them
 *  - trashed photos do not count toward the photo cap
 *  - the trash routes are scoped to the gallery like delete is
 *  - retention 0 deletes at once, as before the trash
 *  - an external photo's file is never moved: the row is trashed and an
 *    import exclusion holds the watcher off until it is restored
 *  - the sweep purges what is past its retention, tolerates a file already
 *    gone, and finishes a trash, restore or purge a crash interrupted
 *  - deleting the event deletes its trash, rows and files
 *  - through the S3 backend the move is copy + delete, never a read
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'photo-trash-test-secret';
process.env.EXTERNAL_MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-trash-external-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

describe('photo trash (issue 1733)', () => {
  let db; let cleanup; let app;
  let storage; let storageModule; let photoTrash; let webhookFire;
  const tok = {};
  const id = {};
  let seq = 0;

  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);
  const now = () => new Date().toISOString();
  const firstId = (rows) => rows[0]?.id ?? rows[0];
  const count = async (table, where) => Number((await db(table).where(where).count('* as c').first()).c);

  async function mkAdmin(name, roleName) {
    const adminId = firstId(await db('admin_users').insert({
      username: `trash-${name}`, email: `trash-${name}@example.com`, password_hash: 'x',
      must_change_password: false, created_at: now(),
    }).returning('id'));
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }

  async function mkEvent(overrides = {}) {
    seq += 1;
    const slug = `trash-event-${seq}`;
    const eventId = firstId(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Trash ${seq}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/t`, share_token: `trash-tok-${seq}`,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: id.owner, created_at: now(),
      ...overrides,
    }).returning('id'));
    return db('events').where({ id: eventId }).first();
  }

  /** A managed photo with its original and a thumbnail in storage. */
  async function mkPhoto(event, fields = {}) {
    seq += 1;
    const filename = `IMG_${seq}.jpg`;
    const key = `events/active/${event.slug}/${filename}`;
    const thumb = `thumbnails/thumb_${filename}`;
    await storage.put(key, Buffer.from(`original ${seq}`));
    await storage.put(thumb, Buffer.from('thumb'));
    const photoId = firstId(await db('photos').insert({
      event_id: event.id, filename, original_filename: `Original ${seq}.jpg`, path: `${event.slug}/${filename}`,
      thumbnail_path: thumb, type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: 10 + seq, uploaded_at: now(), processing_status: 'complete', like_count: 1,
      ...fields,
    }).returning('id'));
    return { id: photoId, key, thumb, filename };
  }

  const setRetention = async (days) => {
    await db('app_settings').where({ setting_key: 'general_photo_trash_retention_days' }).del();
    if (days !== undefined) {
      await db('app_settings').insert({
        setting_key: 'general_photo_trash_retention_days', setting_value: JSON.stringify(days), setting_type: 'general',
      });
    }
  };

  const trashRowOf = (photoId) => db('photo_trash').where({ photo_id: photoId }).first();
  const del = (event, photo, who = 'owner') => as(request(app).delete(`/api/admin/events/${event.id}/photos/${photo.id}`), who);
  const restore = (event, ids, who = 'owner') => as(request(app).post(`/api/admin/events/${event.id}/photos/trash/restore`), who).send({ ids });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    id.owner = await mkAdmin('owner', 'solo_photographer');
    id.other = await mkAdmin('other', 'solo_photographer');

    storageModule = require('../../src/services/storage');
    storage = storageModule.getStorage();
    photoTrash = require('../../src/services/photoTrashService');
    webhookFire = jest.spyOn(require('../../src/services/webhookService'), 'fire').mockResolvedValue();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(process.env.EXTERNAL_MEDIA_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await setRetention(undefined);
    webhookFire.mockClear();
  });

  describe('trash and restore', () => {
    it('round-trips the row, its children and the file under the same id', async () => {
      const event = await mkEvent();
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Anna', identifier: 'anna-ident', created_at: now(),
      }).returning('id'));
      const categoryId = firstId(await db('photo_categories').insert({
        name: 'Ceremony', slug: `ceremony-${seq}`, event_id: event.id,
      }).returning('id'));
      const photo = await mkPhoto(event, { category_id: categoryId, face_status: 'complete', face_count: 1 });
      await db('events').where({ id: event.id }).update({ hero_photo_id: photo.id });
      await db('photo_categories').where({ id: categoryId }).update({ hero_photo_id: photo.id });
      await db('photo_feedback').insert([
        { photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'anna-ident', guest_id: guestId },
        { photo_id: photo.id, event_id: event.id, feedback_type: 'comment', comment_text: 'Lovely', guest_identifier: 'x' },
      ]);
      await db('photo_admin_marks').insert({ photo_id: photo.id, event_id: event.id, admin_id: id.owner, rating: 4, color_label: 'red' });
      await db('event_download_grants').insert({ event_id: event.id, photo_id: photo.id, granted_at: now() });
      await db('photo_faces').insert({ photo_id: photo.id, event_id: event.id, bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1 });
      const before = await db('photos').where({ id: photo.id }).first();

      const res = await del(event, photo);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ trashed: 1, deleted: 0, retention_days: 30 });

      // Gone from the gallery, with nothing dangling.
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();
      for (const table of ['photo_feedback', 'photo_admin_marks', 'event_download_grants', 'photo_faces']) {
        expect(await count(table, { photo_id: photo.id })).toBe(0);
      }
      expect((await db('events').where({ id: event.id }).first()).hero_photo_id).toBeNull();
      expect((await db('photo_categories').where({ id: categoryId }).first()).hero_photo_id).toBeNull();
      expect(webhookFire).toHaveBeenCalledWith('photo.deleted', expect.objectContaining({
        photo: { id: photo.id, filename: photo.filename },
      }));

      // The original moved under trash/, the derived file is dropped.
      const row = await trashRowOf(photo.id);
      expect(row).toMatchObject({ state: 'trashed', event_id: event.id, original_key: photo.key, deleted_by: id.owner, deleted_by_name: 'trash-owner' });
      expect(row.trash_key.startsWith(`trash/${event.id}/`)).toBe(true);
      expect(await storage.exists(photo.key)).toBe(false);
      expect(await storage.exists(photo.thumb)).toBe(false);
      expect(await storage.exists(row.trash_key)).toBe(true);
      expect(Date.parse(row.purge_after) - Date.parse(row.deleted_at)).toBe(30 * 86400000);

      const list = await as(request(app).get(`/api/admin/events/${event.id}/photos/trash`), 'owner');
      expect(list.status).toBe(200);
      expect(list.body.retention_days).toBe(30);
      expect(list.body.items).toEqual([expect.objectContaining({
        id: row.id, photo_id: photo.id, filename: before.original_filename, deleted_by_name: 'trash-owner', size_bytes: before.size_bytes,
      })]);

      const back = await restore(event, [row.id]);
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ restored: 1, photo_ids: [photo.id], failed: [] });

      const after = await db('photos').where({ id: photo.id }).first();
      expect(after).toMatchObject({
        id: photo.id, event_id: event.id, filename: before.filename, path: before.path, category_id: categoryId,
        original_filename: before.original_filename, size_bytes: before.size_bytes, uploaded_at: before.uploaded_at, like_count: 1,
        // Derived files are regenerated: the worker picks the row up again.
        processing_status: 'pending', thumbnail_path: null, face_status: null,
      });
      expect(await storage.exists(photo.key)).toBe(true);
      expect(await storage.exists(row.trash_key)).toBe(false);
      expect(await trashRowOf(photo.id)).toBeUndefined();

      const feedback = await db('photo_feedback').where({ photo_id: photo.id }).orderBy('feedback_type');
      expect(feedback.map((f) => [f.feedback_type, f.comment_text, f.guest_id])).toEqual([['comment', 'Lovely', null], ['like', null, guestId]]);
      expect(await db('photo_admin_marks').where({ photo_id: photo.id }).first()).toMatchObject({ admin_id: id.owner, rating: 4, color_label: 'red' });
      expect((await db('events').where({ id: event.id }).first()).hero_photo_id).toBe(photo.id);
      expect((await db('photo_categories').where({ id: categoryId }).first()).hero_photo_id).toBe(photo.id);
      // Not kept: biometric data and download grants.
      expect(await count('photo_faces', { photo_id: photo.id })).toBe(0);
      expect(await count('event_download_grants', { photo_id: photo.id })).toBe(0);
    });

    it('bulk delete trashes every photo and reports the counts', async () => {
      const event = await mkEvent();
      const a = await mkPhoto(event);
      const b = await mkPhoto(event);
      const res = await as(request(app).post(`/api/admin/events/${event.id}/photos/bulk-delete`), 'owner').send({ photoIds: [a.id, b.id] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ trashed: 2, deleted: 0, failed: [] });
      expect(await count('photos', { event_id: event.id })).toBe(0);
      expect(await count('photo_trash', { event_id: event.id, state: 'trashed' })).toBe(2);
      expect(webhookFire).toHaveBeenCalledTimes(2);

      const rows = await db('photo_trash').where({ event_id: event.id });
      const back = await restore(event, rows.map((r) => r.id));
      expect(back.body.restored).toBe(2);
      expect(await storage.exists(a.key)).toBe(true);
      expect(await storage.exists(b.key)).toBe(true);
    });

    it('drops what a restored row pointed at when that is gone meanwhile', async () => {
      const event = await mkEvent();
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Ben', identifier: 'ben-ident', created_at: now(),
      }).returning('id'));
      const categoryId = firstId(await db('photo_categories').insert({ name: 'Party', slug: `party-${seq}`, event_id: event.id }).returning('id'));
      const photo = await mkPhoto(event, {
        category_id: categoryId, uploader_guest_id: guestId, credit_name: 'Ben', credit_source: 'guest', like_count: 1,
      });
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'ben-ident', guest_id: guestId });
      expect((await del(event, photo)).status).toBe(200);

      // The guest row and the category were deleted meanwhile.
      await db('gallery_guests').where({ id: guestId }).del();
      await db('photo_categories').where({ id: categoryId }).del();

      const row = await trashRowOf(photo.id);
      expect((await restore(event, [row.id])).status).toBe(200);
      expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({
        category_id: null, uploader_guest_id: null, credit_name: null, credit_source: null, like_count: 1,
      });
      // The like still counts; it no longer names anyone.
      expect(await db('photo_feedback').where({ photo_id: photo.id }).first()).toMatchObject({ feedback_type: 'like', guest_id: null });
    });

    it('forgets a guest inside the trash too, not only in the gallery', async () => {
      const event = await mkEvent();
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Cara', email: 'cara@example.com', identifier: 'cara-ident', created_at: now(),
      }).returning('id'));
      const photo = await mkPhoto(event, { uploader_guest_id: guestId, credit_name: 'Cara', credit_source: 'guest', uploaded_by: 'guest' });
      await db('photo_feedback').insert([
        { photo_id: photo.id, event_id: event.id, feedback_type: 'comment', comment_text: 'Mine', guest_identifier: 'cara-ident', guest_id: guestId, guest_name: 'Cara', guest_email: 'cara@example.com' },
        { photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'someone-else', guest_name: 'Dan' },
      ]);
      expect((await del(event, photo)).status).toBe(200);
      expect((await trashRowOf(photo.id)).children).toContain('cara@example.com');

      // What both erasure routes call (admin removes the guest, or "forget me").
      await require('../../src/services/feedbackService').anonymizeGuestFeedback(guestId);

      const row = await trashRowOf(photo.id);
      expect(row.children).not.toContain('cara@example.com');
      expect(row.children).not.toContain('"Cara"');
      expect(row.photo_row).not.toContain('"Cara"');
      expect(JSON.parse(row.children).feedback.map((f) => [f.feedback_type, f.guest_id, f.guest_name])).toEqual(
        expect.arrayContaining([['comment', null, null], ['like', null, 'Dan']])
      );

      expect((await restore(event, [row.id])).status).toBe(200);
      expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({ uploader_guest_id: null, credit_name: null, credit_source: null });
      expect(await count('photo_feedback', { photo_id: photo.id })).toBe(2);
    });

    it('brings a photo held for review back held, and announces nothing', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event, { moderation_status: 'pending', visibility: 'hidden', uploaded_by_admin_id: id.other });
      expect((await del(event, photo)).status).toBe(200);
      webhookFire.mockClear();

      const row = await trashRowOf(photo.id);
      expect((await restore(event, [row.id])).status).toBe(200);
      const after = await db('photos').where({ id: photo.id }).first();
      expect(after).toMatchObject({ moderation_status: 'pending', visibility: 'hidden', uploaded_by_admin_id: id.other });
      expect(after.restored_from_trash_at).toEqual(expect.any(String));
      expect(webhookFire).not.toHaveBeenCalled();
    });

    it('does not fire photo.uploaded when the restored photo is processed again', async () => {
      const sharp = require('sharp');
      const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 80, b: 20 } } }).jpeg().toBuffer();
      const { processPhoto } = require('../../src/services/photoProcessor');
      const event = await mkEvent();
      const restored = await mkPhoto(event);
      const fresh = await mkPhoto(event, { processing_status: 'pending', thumbnail_path: null });
      await storage.put(restored.key, jpeg);
      await storage.put(fresh.key, jpeg);

      expect((await del(event, restored)).status).toBe(200);
      expect((await restore(event, [(await trashRowOf(restored.id)).id])).status).toBe(200);
      webhookFire.mockClear();

      await processPhoto(restored.id);
      const row = await db('photos').where({ id: restored.id }).first();
      expect(row.processing_status).toBe('complete');
      expect(await storage.exists(row.thumbnail_path)).toBe(true);
      expect(webhookFire).not.toHaveBeenCalledWith('photo.uploaded', expect.anything());

      // The control: an upload's first processing run does announce it.
      await processPhoto(fresh.id);
      expect(webhookFire).toHaveBeenCalledWith('photo.uploaded', expect.objectContaining({ photo: expect.objectContaining({ id: fresh.id }) }));
    });

    it('keeps a global category, which belongs to no gallery', async () => {
      const event = await mkEvent();
      const globalId = firstId(await db('photo_categories').insert({ name: 'Global', slug: `global-${seq}`, is_global: 1, event_id: null }).returning('id'));
      const photo = await mkPhoto(event, { category_id: globalId });
      expect((await del(event, photo)).status).toBe(200);
      expect((await restore(event, [(await trashRowOf(photo.id)).id])).status).toBe(200);
      expect((await db('photos').where({ id: photo.id }).first()).category_id).toBe(globalId);
    });

    it('follows a gallery that was renamed while the photo was in the trash', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const renamed = `${event.slug}-renamed`;
      await db('events').where({ id: event.id }).update({ slug: renamed });

      const row = await trashRowOf(photo.id);
      expect((await restore(event, [row.id])).status).toBe(200);
      expect((await db('photos').where({ id: photo.id }).first()).path).toBe(`${renamed}/${photo.filename}`);
      expect(await storage.exists(`events/active/${renamed}/${photo.filename}`)).toBe(true);
    });
  });

  describe('a restore that cannot happen leaves the photo in the trash', () => {
    it('restores under a new id, children with it, when the old id is in use again', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'x' });
      await db('photo_admin_marks').insert({ photo_id: photo.id, event_id: event.id, admin_id: id.owner, rating: 5 });
      await db('events').where({ id: event.id }).update({ hero_photo_id: photo.id });
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      // What a restored database backup leads to: the id handed out again.
      await db('photos').insert({
        id: photo.id, event_id: event.id, filename: 'other.jpg', path: `${event.slug}/other.jpg`, type: 'individual', uploaded_at: now(),
      });

      const res = await restore(event, [row.id]);
      expect(res.status).toBe(200);
      expect(res.body.restored).toBe(1);
      const newId = res.body.photo_ids[0];
      expect(newId).not.toBe(photo.id);
      expect(res.body.reassigned).toEqual([{ previous_photo_id: photo.id, photo_id: newId }]);

      // The photo that holds the old id is untouched, and owns none of the children.
      expect((await db('photos').where({ id: photo.id }).first()).filename).toBe('other.jpg');
      expect(await count('photo_feedback', { photo_id: photo.id })).toBe(0);
      expect(await count('photo_admin_marks', { photo_id: photo.id })).toBe(0);

      expect(await db('photos').where({ id: newId }).first()).toMatchObject({ filename: photo.filename, path: `${event.slug}/${photo.filename}` });
      expect(await count('photo_feedback', { photo_id: newId })).toBe(1);
      expect(await db('photo_admin_marks').where({ photo_id: newId }).first()).toMatchObject({ rating: 5 });
      expect((await db('events').where({ id: event.id }).first()).hero_photo_id).toBe(newId);
      expect(await storage.exists(photo.key)).toBe(true);
      expect(await db('photo_trash').where({ id: row.id }).first()).toBeUndefined();
    });

    it('does not count trash toward the photo cap, and respects the cap on restore', async () => {
      const event = await mkEvent({ photo_cap: 1 });
      const photo = await mkPhoto(event);
      const { isPhotoCapReached } = require('../../src/services/photoCap');
      expect(await isPhotoCapReached(event)).toBe(true);

      expect((await del(event, photo)).status).toBe(200);
      expect(await isPhotoCapReached(event)).toBe(false);

      // The freed place is taken; the trashed photo no longer fits.
      const second = await mkPhoto(event);
      const row = await trashRowOf(photo.id);
      const res = await restore(event, [row.id]);
      expect(res.status).toBe(409);
      expect(res.body.failed[0].code).toBe('PHOTO_CAP_REACHED');
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
      expect(await storage.exists(row.trash_key)).toBe(true);
      expect(await storage.exists(photo.key)).toBe(false);
      expect(await storage.exists(second.key)).toBe(true);
    });

    it('reports a file that is no longer in the trash', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      await storage.delete(row.trash_key);

      const res = await restore(event, [row.id]);
      expect(res.status).toBe(409);
      expect(res.body.failed[0].code).toBe('TRASH_FILE_MISSING');
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
    });
  });

  describe('scope', () => {
    it('keeps the gallery of another admin out of reach', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      const base = `/api/admin/events/${event.id}/photos/trash`;

      expect((await as(request(app).get(base), 'other')).status).toBe(403);
      expect((await as(request(app).post(`${base}/restore`), 'other').send({ ids: [row.id] })).status).toBe(403);
      expect((await as(request(app).post(`${base}/purge`), 'other').send({ ids: [row.id] })).status).toBe(403);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
    });

    it('does not act on a trash row of another gallery through its own', async () => {
      const mine = await mkEvent({ created_by: id.other });
      const theirs = await mkEvent();
      const photo = await mkPhoto(theirs);
      expect((await del(theirs, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      const base = `/api/admin/events/${mine.id}/photos/trash`;

      expect((await as(request(app).post(`${base}/restore`), 'other').send({ ids: [row.id] })).status).toBe(404);
      expect((await as(request(app).post(`${base}/purge`), 'other').send({ ids: [row.id] })).status).toBe(404);
      expect(await storage.exists(row.trash_key)).toBe(true);
    });

    it('refuses ids that are not positive integers', async () => {
      const event = await mkEvent();
      const res = await restore(event, ['1; drop']);
      expect(res.status).toBe(400);
    });
  });

  describe('deleting for good', () => {
    it('purges a trashed photo on request: file and row', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      webhookFire.mockClear();

      const res = await as(request(app).post(`/api/admin/events/${event.id}/photos/trash/purge`), 'owner').send({ ids: [row.id] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ purged: 1, failed: [] });
      expect(await trashRowOf(photo.id)).toBeUndefined();
      expect(await storage.exists(row.trash_key)).toBe(false);
      // photo.deleted fired when the photo was trashed, not again here.
      expect(webhookFire).not.toHaveBeenCalled();
    });

    it('deletes at once with a retention of 0, as before the trash', async () => {
      await setRetention(0);
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const res = await del(event, photo);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ trashed: 0, deleted: 1 });
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();
      expect(await trashRowOf(photo.id)).toBeUndefined();
      expect(await storage.exists(photo.key)).toBe(false);
    });

    it('deletes a photo whose original is already missing outright', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await storage.delete(photo.key);
      const res = await del(event, photo);
      expect(res.body).toMatchObject({ trashed: 0, deleted: 1 });
      expect(await trashRowOf(photo.id)).toBeUndefined();
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();
    });

    it('takes the retention from the setting', async () => {
      await setRetention(7);
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body.retention_days).toBe(7);
      const row = await trashRowOf(photo.id);
      expect(Date.parse(row.purge_after) - Date.parse(row.deleted_at)).toBe(7 * 86400000);
    });
  });

  describe('the folder watcher', () => {
    let watcher;
    const abs = (key) => path.join(process.env.STORAGE_PATH, key);
    /** Runs `during` right after the next storage move, before the caller's transaction. */
    const afterNextMove = (during) => {
      const rename = storage.rename.bind(storage);
      const spy = jest.spyOn(storage, 'rename').mockImplementation(async (...args) => {
        spy.mockRestore();
        await rename(...args);
        await during();
      });
    };

    beforeAll(() => { watcher = require('../../src/services/fileWatcher'); });

    it('leaves the row and children alone when it sees the file leave BEFORE the transaction', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'x' });
      let rowSeenByWatcher;
      afterNextMove(async () => {
        await watcher.removePhoto(abs(photo.key));
        rowSeenByWatcher = await db('photos').where({ id: photo.id }).first();
      });

      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      // The watcher ran in the gap and deleted nothing.
      expect(rowSeenByWatcher).toBeDefined();
      // Exactly one photo.deleted: the route's, without the watcher's `source`.
      const deleted = webhookFire.mock.calls.filter(([type]) => type === 'photo.deleted');
      expect(deleted).toEqual([['photo.deleted', expect.objectContaining({ photo: { id: photo.id, filename: photo.filename } })]]);
      // The transaction still found the children to snapshot.
      expect(JSON.parse((await trashRowOf(photo.id)).children).feedback).toHaveLength(1);
      expect(await count('photo_feedback', { photo_id: photo.id })).toBe(0);
    });

    it('does nothing when it sees the file leave AFTER the transaction', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      webhookFire.mockClear();

      await watcher.removePhoto(abs(photo.key));
      expect(webhookFire).not.toHaveBeenCalled();
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
    });

    it('still removes the row of a file somebody deleted from the folder', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await storage.delete(photo.key);
      await watcher.removePhoto(abs(photo.key));
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();
      expect(webhookFire).toHaveBeenCalledWith('photo.deleted', expect.objectContaining({
        photo: expect.objectContaining({ id: photo.id, source: 'auto-import' }),
      }));
    });

    it('does not import a file a restore is putting back as a new photo', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      webhookFire.mockClear();

      let rowsSeenByWatcher;
      afterNextMove(async () => {
        // The file is back under events/active and no photo row names it yet.
        await watcher.processNewPhoto(abs(photo.key));
        rowsSeenByWatcher = await count('photos', { event_id: event.id });
      });
      expect((await restore(event, [row.id])).status).toBe(200);

      expect(rowsSeenByWatcher).toBe(0);
      expect((await db('photos').where({ event_id: event.id })).map((p) => p.id)).toEqual([photo.id]);
      expect(webhookFire).not.toHaveBeenCalled();

      // After the restore the watcher finds the row and has nothing to add.
      await watcher.processNewPhoto(abs(photo.key));
      expect(await count('photos', { event_id: event.id })).toBe(1);
    });
  });

  describe('external photos', () => {
    it('trashes the row only and holds the watcher off until it is restored', async () => {
      const event = await mkEvent({ source_mode: 'reference' });
      const relpath = `shoot-${seq}/DSC_1.jpg`;
      const abs = path.join(process.env.EXTERNAL_MEDIA_ROOT, relpath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, 'nas bytes');
      const photoId = firstId(await db('photos').insert({
        event_id: event.id, filename: 'DSC_1.jpg', path: relpath, source_origin: 'external', external_relpath: relpath,
        type: 'individual', uploaded_at: now(), processing_status: 'complete',
      }).returning('id'));

      expect((await del(event, { id: photoId })).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photoId);
      expect(row).toMatchObject({ state: 'trashed', original_key: null, trash_key: null });
      expect(fs.existsSync(abs)).toBe(true);
      expect(await count('external_import_exclusions', { event_id: event.id, external_relpath: relpath })).toBe(1);

      expect((await restore(event, [row.id])).status).toBe(200);
      expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ external_relpath: relpath, source_origin: 'external' });
      expect(await count('external_import_exclusions', { event_id: event.id, external_relpath: relpath })).toBe(0);
      expect(fs.existsSync(abs)).toBe(true);
    });
  });

  describe('the sweep', () => {
    const expire = (rowId) => db('photo_trash').where({ id: rowId }).update({ purge_after: new Date(Date.now() - 1000).toISOString() });
    const age = (rowId, state) => db('photo_trash').where({ id: rowId })
      .update({ state, state_changed_at: new Date(Date.now() - 3600000).toISOString() });

    it('purges what is past its retention and keeps the rest', async () => {
      const event = await mkEvent();
      const old = await mkPhoto(event);
      const gone = await mkPhoto(event);
      const fresh = await mkPhoto(event);
      for (const photo of [old, gone, fresh]) expect((await del(event, photo)).status).toBe(200);
      const [oldRow, goneRow, freshRow] = await Promise.all([old, gone, fresh].map((p) => trashRowOf(p.id)));
      await expire(oldRow.id);
      await expire(goneRow.id);
      // Already removed by hand: the row still goes.
      await storage.delete(goneRow.trash_key);

      const result = await photoTrash.purgeExpired();
      expect(result.purged).toBe(2);
      expect(await trashRowOf(old.id)).toBeUndefined();
      expect(await trashRowOf(gone.id)).toBeUndefined();
      expect(await storage.exists(oldRow.trash_key)).toBe(false);
      expect(await trashRowOf(fresh.id)).toMatchObject({ state: 'trashed' });
      expect(await storage.exists(freshRow.trash_key)).toBe(true);
    });

    it('lets only one caller purge a row', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      const results = await Promise.all([photoTrash.purgeTrashRow(row), photoTrash.purgeTrashRow(row)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('puts the file back when a trashing crashed after the move', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const trashKey = `trash/${event.id}/crashed/${photo.filename}`;
      await storage.rename(photo.key, trashKey);
      const rowId = firstId(await db('photo_trash').insert({
        photo_id: photo.id, event_id: event.id, state: 'pending', state_changed_at: now(), filename: photo.filename,
        original_key: photo.key, trash_key: trashKey, deleted_at: now(), purge_after: now(),
        photo_row: JSON.stringify(await db('photos').where({ id: photo.id }).first()), children: '{}',
      }).returning('id'));

      // Too recent to be a crash: another replica may be at work.
      await photoTrash.purgeExpired();
      expect(await storage.exists(trashKey)).toBe(true);

      await age(rowId, 'pending');
      await photoTrash.purgeExpired();
      expect(await storage.exists(photo.key)).toBe(true);
      expect(await storage.exists(trashKey)).toBe(false);
      expect(await db('photo_trash').where({ id: rowId }).first()).toBeUndefined();
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
    });

    it('keeps the file in the trash when the photo row went while it was moving', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const trashKey = `trash/${event.id}/watcher/${photo.filename}`;
      await storage.rename(photo.key, trashKey);
      const rowId = firstId(await db('photo_trash').insert({
        photo_id: photo.id, event_id: event.id, state: 'pending', state_changed_at: now(), filename: photo.filename,
        original_key: photo.key, trash_key: trashKey, deleted_at: now(), purge_after: new Date(Date.now() + 86400000).toISOString(),
        photo_row: JSON.stringify(await db('photos').where({ id: photo.id }).first()), children: '{}',
      }).returning('id'));
      // What the folder watcher does when it sees the file leave.
      await db('photos').where({ id: photo.id }).del();

      await age(rowId, 'pending');
      await photoTrash.purgeExpired();
      expect(await db('photo_trash').where({ id: rowId }).first()).toMatchObject({ state: 'trashed' });
      expect(await storage.exists(trashKey)).toBe(true);

      expect((await restore(event, [rowId])).status).toBe(200);
      expect(await storage.exists(photo.key)).toBe(true);
    });

    it('returns a photo to the trash when a restore crashed after the move', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      await storage.rename(row.trash_key, photo.key);
      await age(row.id, 'restoring');

      await photoTrash.purgeExpired();
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
      expect(await storage.exists(row.trash_key)).toBe(true);
      expect(await storage.exists(photo.key)).toBe(false);
    });

    it('finishes a purge that crashed after the file was deleted', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      await storage.delete(row.trash_key);
      await age(row.id, 'purging');

      await photoTrash.purgeExpired();
      expect(await trashRowOf(photo.id)).toBeUndefined();
    });
  });

  describe('deleting the event', () => {
    it('deletes its trash, rows and files', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const kept = await mkEvent();
      const keptPhoto = await mkPhoto(kept);
      expect((await del(event, photo)).status).toBe(200);
      expect((await del(kept, keptPhoto)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      const keptRow = await trashRowOf(keptPhoto.id);

      const { deleteEventCascade } = require('../../src/routes/adminEvents/helpers');
      await deleteEventCascade(event.id, { id: id.owner, username: 'trash-owner' });

      expect(await count('photo_trash', { event_id: event.id })).toBe(0);
      expect(await storage.exists(row.trash_key)).toBe(false);
      expect(await trashRowOf(keptPhoto.id)).toMatchObject({ state: 'trashed' });
      expect(await storage.exists(keptRow.trash_key)).toBe(true);
    });
  });

  describe('through the S3 backend', () => {
    let backend; let objects; let calls;

    beforeAll(() => {
      const S3StorageBackend = require('../../src/services/storage/S3StorageBackend');
      backend = new S3StorageBackend({ bucket: 'test', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
      objects = new Map();
      calls = [];
      const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      // The adapter's surface the trash may use. Anything that reads an
      // object's body (download, downloadStream) is absent on purpose: a
      // call would throw.
      backend.adapter = {
        bucket: 'test',
        s3Client: {
          send: async (command) => {
            const key = command.input.Key;
            if (!objects.has(key)) throw notFound();
            return { ContentLength: objects.get(key).length };
          },
        },
        uploadStream: async (stream, key) => {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          objects.set(key, Buffer.concat(chunks));
        },
        copy: async (src, dst) => {
          calls.push(['copy', src, dst]);
          if (!objects.has(src)) throw notFound();
          objects.set(dst, objects.get(src));
        },
        delete: async (key) => { calls.push(['delete', key]); objects.delete(key); },
        exists: async (key) => objects.has(key),
      };
      backend.indexLoaded = true;
      storageModule.setStorageForTesting(backend);
      storage = backend;
    });

    afterAll(() => {
      storageModule.resetStorage();
      storage = storageModule.getStorage();
    });

    it('moves the original with copy + delete, there and back', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      calls.length = 0;

      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);
      expect(calls.slice(0, 2)).toEqual([['copy', photo.key, row.trash_key], ['delete', photo.key]]);
      expect(objects.has(photo.key)).toBe(false);
      expect(objects.get(row.trash_key).toString()).toMatch(/^original/);
      expect(objects.has(photo.thumb)).toBe(false);

      calls.length = 0;
      expect((await restore(event, [row.id])).status).toBe(200);
      expect(calls).toEqual([['copy', row.trash_key, photo.key], ['delete', row.trash_key]]);
      expect(objects.has(photo.key)).toBe(true);
      expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({ processing_status: 'pending' });
    });

    it('leaves the photo in the gallery when the copy fails', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const copy = backend.adapter.copy;
      backend.adapter.copy = async () => { throw new Error('S3 is down'); };
      try {
        expect((await del(event, photo)).status).toBe(500);
      } finally {
        backend.adapter.copy = copy;
      }
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      expect(objects.has(photo.key)).toBe(true);
      expect(await trashRowOf(photo.id)).toBeUndefined();
    });

    it('refuses an object S3 cannot copy in one request, and deletes nothing', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const send = backend.adapter.s3Client.send;
      backend.adapter.s3Client.send = async (command) => ({ ...(await send(command)), ContentLength: 6 * 1024 ** 3 });
      calls.length = 0;
      let res;
      try {
        res = await del(event, photo);
      } finally {
        backend.adapter.s3Client.send = send;
      }
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRASH_TOO_LARGE');
      expect(calls).toEqual([]);
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      expect(objects.has(photo.key)).toBe(true);
      expect(await trashRowOf(photo.id)).toBeUndefined();
    });

    it('drops the surplus copy when a trashing crashed between copy and delete', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const trashKey = `trash/${event.id}/half/${photo.filename}`;
      objects.set(trashKey, objects.get(photo.key));
      const rowId = firstId(await db('photo_trash').insert({
        photo_id: photo.id, event_id: event.id, state: 'pending',
        state_changed_at: new Date(Date.now() - 3600000).toISOString(), filename: photo.filename,
        original_key: photo.key, trash_key: trashKey, deleted_at: now(), purge_after: now(),
        photo_row: '{}', children: '{}',
      }).returning('id'));

      await photoTrash.purgeExpired();
      expect(objects.has(photo.key)).toBe(true);
      expect(objects.has(trashKey)).toBe(false);
      expect(await db('photo_trash').where({ id: rowId }).first()).toBeUndefined();
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
    });
  });
});
