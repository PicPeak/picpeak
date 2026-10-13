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
 *  - forgetting a guest reaches what the trash holds of them, and so does
 *    merging guests
 *  - a snapshot taken on SQLite restores on PostgreSQL
 *  - a backup requires the originals of trashed photos
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
    app.use('/api/admin', require('../../src/routes/adminGuests'));
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
      await require('../../src/services/photoCredit').clearGuestCredits(guestId);

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

    it('carries a guest merge into the trash: uploads and feedback come back as the survivor\'s', async () => {
      const event = await mkEvent();
      const mkGuest = async (name) => firstId(await db('gallery_guests').insert({
        event_id: event.id, name, email: `${name.toLowerCase()}@example.com`, identifier: `${name.toLowerCase()}-merge-ident`, created_at: now(),
      }).returning('id'));
      const keepId = await mkGuest('Hana');
      const goneId = await mkGuest('Hanna');
      const photo = await mkPhoto(event, { uploader_guest_id: goneId, credit_name: 'Hanna', credit_source: 'guest', uploaded_by: 'guest', like_count: 2 });
      const fb = (extra) => ({ photo_id: photo.id, event_id: event.id, ...extra });
      await db('photo_feedback').insert([
        fb({ feedback_type: 'like', guest_identifier: 'hana-merge-ident', guest_id: keepId, guest_name: 'Hana', created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' }),
        fb({ feedback_type: 'like', guest_identifier: 'hanna-merge-ident', guest_id: goneId, guest_name: 'Hanna', created_at: '2026-01-02T10:00:00.000Z', updated_at: '2026-01-02T10:00:00.000Z' }),
        fb({ feedback_type: 'comment', comment_text: 'From the other phone', guest_identifier: 'hanna-merge-ident', guest_id: goneId, guest_name: 'Hanna' }),
        fb({ feedback_type: 'like', guest_identifier: 'someone-else', guest_name: 'Ida' }),
      ]);
      expect((await del(event, photo)).status).toBe(200);

      const merge = await as(request(app).post(`/api/admin/events/${event.id}/guests/${keepId}/merge`), 'owner').send({ mergeIds: [goneId] });
      expect(merge.status).toBe(200);
      const row = await trashRowOf(photo.id);
      expect(JSON.parse(row.photo_row)).toMatchObject({ uploader_guest_id: keepId, credit_name: 'Hana', credit_source: 'guest' });

      expect((await restore(event, [row.id])).status).toBe(200);
      // The uploader and their choices are the survivor's; of the two likes one is left.
      expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({
        uploader_guest_id: keepId, credit_name: 'Hana', credit_source: 'guest', like_count: 2,
      });
      const feedback = await db('photo_feedback').where({ photo_id: photo.id }).orderBy('id');
      expect(feedback.map((f) => [f.feedback_type, f.guest_id, f.guest_identifier])).toEqual([
        ['like', keepId, 'hana-merge-ident'],
        ['comment', keepId, 'hana-merge-ident'],
        ['like', null, 'someone-else'],
      ]);
      // The like that stayed is the later one.
      expect(new Date(feedback[0].created_at).toISOString()).toBe('2026-01-02T10:00:00.000Z');
    });

    it('a merge the route refuses leaves the trash as it was', async () => {
      const event = await mkEvent();
      const other = await mkEvent();
      const mkGuest = async (eventId, name) => firstId(await db('gallery_guests').insert({
        event_id: eventId, name, identifier: `${name.toLowerCase()}-ident-${seq}-${eventId}`, created_at: now(),
      }).returning('id'));
      const keepId = await mkGuest(event.id, 'Jo');
      const foreignId = await mkGuest(other.id, 'Joe');
      const photo = await mkPhoto(other, { uploader_guest_id: foreignId, credit_name: 'Joe', credit_source: 'guest' });
      expect((await del(other, photo)).status).toBe(200);
      const before = await trashRowOf(photo.id);

      const merge = await as(request(app).post(`/api/admin/events/${event.id}/guests/${keepId}/merge`), 'owner').send({ mergeIds: [foreignId] });
      expect(merge.status).toBe(400);
      expect((await trashRowOf(photo.id)).photo_row).toBe(before.photo_row);
    });

    it('restores a snapshot whose timestamps are epoch numbers, as SQLite wrote them', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'x' });
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      const at = Date.parse('2026-03-04T05:06:07.000Z');
      const children = JSON.parse(row.children);
      children.feedback = children.feedback.map((f) => ({ ...f, created_at: at, updated_at: at, is_hidden: 0 }));
      await db('photo_trash').where({ id: row.id }).update({
        photo_row: JSON.stringify({ ...JSON.parse(row.photo_row), uploaded_at: at }), children: JSON.stringify(children),
      });

      expect((await restore(event, [row.id])).status).toBe(200);
      expect(new Date((await db('photos').where({ id: photo.id }).first()).uploaded_at).getTime()).toBe(at);
      expect(new Date((await db('photo_feedback').where({ photo_id: photo.id }).first()).created_at).getTime()).toBe(at);
    });

    it('turns SQLite values in a snapshot into what PostgreSQL takes', async () => {
      // SQLite cannot show the insert failing; this pins the conversion PostgreSQL gets.
      const config = db.client.config;
      const engine = config.client;
      config.client = 'pg';
      let forEngine;
      try {
        forEngine = await photoTrash.snapshotCoercion();
      } finally {
        config.client = engine;
      }
      expect(forEngine('photo_feedback', { created_at: 1786548038763, updated_at: '1786548038763', is_hidden: 0, comment_text: '12345', rating: 4 })).toEqual({
        created_at: '2026-08-12T15:20:38.763Z', updated_at: '2026-08-12T15:20:38.763Z', is_hidden: false, comment_text: '12345', rating: 4,
      });
      expect(forEngine('photos', { uploaded_at: '2026-01-01T00:00:00.000Z', size_bytes: 12 })).toEqual({ uploaded_at: '2026-01-01T00:00:00.000Z', size_bytes: 12 });
      expect((await photoTrash.snapshotCoercion())('photos', { uploaded_at: 5 })).toEqual({ uploaded_at: 5 });
    });

    it('applies a folder request that was decided while the photo was in the trash', async () => {
      const event = await mkEvent();
      const folderId = firstId(await db('photo_categories').insert({ name: 'Reception', slug: `reception-${seq}`, event_id: event.id }).returning('id'));
      const mkRequest = async (folderPath) => firstId(await db('folder_requests').insert({
        event_id: event.id, path: folderPath, status: 'pending',
      }).returning('id'));
      const approvedId = await mkRequest('Reception');
      const rejectedId = await mkRequest('Elsewhere');
      const approved = await mkPhoto(event, { pending_folder_request_id: approvedId });
      const rejected = await mkPhoto(event, { pending_folder_request_id: rejectedId });
      for (const photo of [approved, rejected]) expect((await del(event, photo)).status).toBe(200);

      // The decisions reach the photos in the gallery; these two are not there.
      await db('folder_requests').where({ id: approvedId }).update({ status: 'approved', approved_folder_id: folderId });
      await db('folder_requests').where({ id: rejectedId }).update({ status: 'rejected' });

      const rows = await db('photo_trash').where({ event_id: event.id });
      expect((await restore(event, rows.map((row) => row.id))).body.restored).toBe(2);
      expect(await db('photos').where({ id: approved.id }).first()).toMatchObject({ folder_id: folderId, pending_folder_request_id: null });
      expect(await db('photos').where({ id: rejected.id }).first()).toMatchObject({ folder_id: null, pending_folder_request_id: null });
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
      // Marked like every restored row: the folder watcher tells it from the row before the trash by this.
      expect(after.restored_from_trash_at).toEqual(expect.any(String));
      expect(webhookFire).not.toHaveBeenCalled();
    });

    it('announces a held photo that is approved after its restore, while it is still processing', async () => {
      const sharp = require('sharp');
      const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 20, g: 80, b: 200 } } }).jpeg().toBuffer();
      const { processPhoto } = require('../../src/services/photoProcessor');
      const { moderatePhotos } = require('../../src/services/uploadReviewService');
      const event = await mkEvent();
      const photo = await mkPhoto(event, { moderation_status: 'pending', visibility: 'hidden', uploaded_by_admin_id: id.other });
      await storage.put(photo.key, jpeg);
      expect((await del(event, photo)).status).toBe(200);
      expect((await restore(event, [(await trashRowOf(photo.id)).id])).status).toBe(200);
      webhookFire.mockClear();

      // Approved before the worker is done: the approval leaves the announcement to the worker.
      await moderatePhotos(event.id, [photo.id], 'approve');
      expect(webhookFire).not.toHaveBeenCalledWith('photo.uploaded', expect.anything());
      expect((await db('photos').where({ id: photo.id }).first()).restored_from_trash_at).toBeNull();
      await processPhoto(photo.id);
      // It was never announced before: held uploads are not.
      expect(webhookFire).toHaveBeenCalledWith('photo.uploaded', expect.objectContaining({ photo: expect.objectContaining({ id: photo.id }) }));
    });

    it('gives a global category its cover back', async () => {
      const event = await mkEvent();
      const globalId = firstId(await db('photo_categories').insert({ name: 'Global cover', slug: `global-cover-${seq}`, is_global: 1, event_id: null }).returning('id'));
      const photo = await mkPhoto(event, { category_id: globalId });
      await db('photo_categories').where({ id: globalId }).update({ hero_photo_id: photo.id });
      expect((await del(event, photo)).status).toBe(200);
      expect((await db('photo_categories').where({ id: globalId }).first()).hero_photo_id).toBeNull();

      expect((await restore(event, [(await trashRowOf(photo.id)).id])).status).toBe(200);
      expect((await db('photo_categories').where({ id: globalId }).first()).hero_photo_id).toBe(photo.id);
      await db('photo_categories').where({ id: globalId }).update({ hero_photo_id: null });
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
    it('removes a photo that reuses the id and path of one at rest in the trash when its file is deleted', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      // After a database restore: a new photo under the old id and name.
      await storage.put(photo.key, Buffer.from('new photo'));
      await db('photos').insert({
        id: photo.id, event_id: event.id, filename: photo.filename, path: `${event.slug}/${photo.filename}`, type: 'individual',
        uploaded_at: now(), processing_status: 'complete',
      });
      await storage.delete(photo.key);

      await watcher.removePhoto(abs(photo.key));
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
    });

    it('ignores an unlink it gets to only after the photo was restored', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'x' });
      expect((await del(event, photo)).status).toBe(200);
      expect((await restore(event, [(await trashRowOf(photo.id)).id])).status).toBe(200);
      webhookFire.mockClear();

      // The unlink of the move into the trash waited in the watcher's queue.
      await watcher.removePhoto(abs(photo.key));
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      expect(await count('photo_feedback', { photo_id: photo.id })).toBe(1);
      expect(webhookFire).not.toHaveBeenCalled();
    });

    it('does not take a restored row for the one it read before the photo was trashed, held photos included', async () => {
      const event = await mkEvent();
      for (const fields of [{}, { moderation_status: 'pending', visibility: 'hidden' }]) {
        const photo = await mkPhoto(event, fields);
        // The watcher has read the live row; trash and restore both land before its delete.
        const access = jest.spyOn(fs.promises, 'access').mockImplementationOnce(async () => {
          expect((await del(event, photo)).status).toBe(200);
          expect((await restore(event, [(await trashRowOf(photo.id)).id])).status).toBe(200);
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        try {
          await watcher.removePhoto(abs(photo.key));
        } finally {
          access.mockRestore();
        }
        expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      }
    });

    it('does not delete a row that was restored while it looked at a removed file', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);

      // No row when the watcher looks; the restore lands before its delete.
      const access = jest.spyOn(fs.promises, 'access').mockImplementationOnce(async () => {
        expect((await restore(event, [row.id])).status).toBe(200);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      try {
        await watcher.removePhoto(abs(photo.key));
      } finally {
        access.mockRestore();
      }
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
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
      // The restore notes that it is moving the file before it does.
      await db('photo_trash').where({ id: row.id }).update({ restore_move_at: now() });

      await photoTrash.purgeExpired();
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed', restore_move_at: null });
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

  describe('interrupted and concurrent operations', () => {
    const age = (rowId, state) => db('photo_trash').where({ id: rowId })
      .update({ state, state_changed_at: new Date(Date.now() - 3600000).toISOString() });
    const bytes = (key) => fs.readFileSync(path.join(process.env.STORAGE_PATH, key)).toString();
    /** A trashing that stopped after the move: pending row, original under trash/. */
    async function crashedTrashing(event, photo) {
      const trashKey = `trash/${event.id}/crashed-${photo.id}/${photo.filename}`;
      await storage.rename(photo.key, trashKey);
      const rowId = firstId(await db('photo_trash').insert({
        photo_id: photo.id, event_id: event.id, state: 'pending', state_changed_at: now(), filename: photo.filename,
        original_key: photo.key, trash_key: trashKey, deleted_at: now(), purge_after: new Date(Date.now() + 86400000).toISOString(),
        photo_row: JSON.stringify(await db('photos').where({ id: photo.id }).first()), children: '{}',
      }).returning('id'));
      return { rowId, trashKey };
    }

    it('does not delete outright a photo whose original a pending trashing holds', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'comment', comment_text: 'Keep me', guest_identifier: 'x' });
      const { rowId, trashKey } = await crashedTrashing(event, photo);

      // The retry: the original is "missing", but the pending row owns it.
      const busy = await del(event, photo);
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('TRASH_BUSY');
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      expect(await count('photo_feedback', { photo_id: photo.id })).toBe(1);
      expect(await storage.exists(trashKey)).toBe(true);

      // Once the first attempt is clearly dead, the retry puts it right and trashes for real.
      await age(rowId, 'pending');
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1, deleted: 0 });
      const rows = await db('photo_trash').where({ photo_id: photo.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('trashed');
      expect(JSON.parse(rows[0].children).feedback.map((f) => f.comment_text)).toEqual(['Keep me']);
      expect(await storage.exists(rows[0].trash_key)).toBe(true);
      expect(await storage.exists(trashKey)).toBe(false);
    });

    it('finishes a crashed trashing when another file has taken the original\'s place', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'x' });
      const { rowId, trashKey } = await crashedTrashing(event, photo);
      await storage.put(photo.key, Buffer.from('dropped into the folder since'));

      await age(rowId, 'pending');
      await photoTrash.purgeExpired();
      // Neither file is deleted or overwritten; the photo is in the trash with its children.
      expect(bytes(photo.key)).toBe('dropped into the folder since');
      expect(bytes(trashKey)).toMatch(/^original/);
      const row = await db('photo_trash').where({ id: rowId }).first();
      expect(row.state).toBe('trashed');
      expect(JSON.parse(row.children).feedback).toHaveLength(1);
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();
    });

    it('bulk delete reports a photo with a pending trashing as failed and keeps it', async () => {
      const event = await mkEvent();
      const held = await mkPhoto(event);
      const free = await mkPhoto(event);
      await crashedTrashing(event, held);
      const res = await as(request(app).post(`/api/admin/events/${event.id}/photos/bulk-delete`), 'owner').send({ photoIds: [held.id, free.id] });
      expect(res.body).toMatchObject({ trashed: 1, deleted: 0, failed: [held.id] });
      expect(await db('photos').where({ id: held.id }).first()).toBeDefined();
    });

    it('allows one pending trashing per photo', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const pending = (extra = {}) => db('photo_trash').insert({
        photo_id: photo.id, event_id: event.id, state: 'pending', state_changed_at: now(), filename: photo.filename,
        deleted_at: now(), purge_after: now(), photo_row: '{}', children: '{}', ...extra,
      });
      await pending();
      await expect(pending()).rejects.toThrow(/unique/i);
      // Entries at rest are not limited: an id can be in use again after a backup restore.
      await pending({ state: 'trashed' });
      await pending({ state: 'trashed' });
    });

    it('trashes an external photo once when two deletes race', async () => {
      const event = await mkEvent({ source_mode: 'reference' });
      const relpath = `race-${seq}/DSC_2.jpg`;
      const file = path.join(process.env.EXTERNAL_MEDIA_ROOT, relpath);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, 'nas bytes');
      const photoId = firstId(await db('photos').insert({
        event_id: event.id, filename: 'DSC_2.jpg', path: relpath, source_origin: 'external', external_relpath: relpath,
        type: 'individual', uploaded_at: now(), processing_status: 'complete',
      }).returning('id'));
      await db('photo_feedback').insert({ photo_id: photoId, event_id: event.id, feedback_type: 'like', guest_identifier: 'x' });
      webhookFire.mockClear();

      const results = await Promise.all([del(event, { id: photoId }), del(event, { id: photoId }), del(event, { id: photoId })]);
      expect(results.filter((res) => res.body.trashed === 1)).toHaveLength(1);
      const rows = await db('photo_trash').where({ photo_id: photoId });
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].children).feedback).toHaveLength(1);
      expect(webhookFire.mock.calls.filter(([type]) => type === 'photo.deleted')).toHaveLength(1);
    });

    it('does not trash a photo a second time from a stale read of its row', async () => {
      const event = await mkEvent({ source_mode: 'reference' });
      const relpath = `stale-${seq}/DSC_3.jpg`;
      const file = path.join(process.env.EXTERNAL_MEDIA_ROOT, relpath);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, 'nas bytes');
      const photoId = firstId(await db('photos').insert({
        event_id: event.id, filename: 'DSC_3.jpg', path: relpath, source_origin: 'external', external_relpath: relpath,
        type: 'individual', uploaded_at: now(), processing_status: 'complete',
      }).returning('id'));
      const stale = await db('photos').where({ id: photoId }).first();
      expect(await photoTrash.trashPhoto(event, stale, null, 30)).toBe(true);
      await expect(photoTrash.trashPhoto(event, stale, null, 30)).rejects.toMatchObject({ code: 'PHOTO_GONE', statusCode: 409 });
      expect(await count('photo_trash', { photo_id: photoId })).toBe(1);
    });

    it('restores without a guest who was forgotten while the file moved', async () => {
      const event = await mkEvent();
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Eve', email: 'eve@example.com', identifier: 'eve-ident', created_at: now(),
      }).returning('id'));
      const photo = await mkPhoto(event, { uploader_guest_id: guestId, credit_name: 'Eve', credit_source: 'guest', uploaded_by: 'guest' });
      await db('photo_feedback').insert({
        photo_id: photo.id, event_id: event.id, feedback_type: 'comment', comment_text: 'Mine', guest_identifier: 'eve-ident',
        guest_id: guestId, guest_name: 'Eve', guest_email: 'eve@example.com',
      });
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);

      // The whole erasure, as the routes run it, lands between the move and the insert.
      const rename = storage.rename.bind(storage);
      const spy = jest.spyOn(storage, 'rename').mockImplementation(async (...args) => {
        spy.mockRestore();
        await rename(...args);
        await require('../../src/services/feedbackService').anonymizeGuestFeedback(guestId);
        await db('gallery_guests').where({ id: guestId }).update({ is_deleted: true, name: 'Removed', email: null });
        await require('../../src/services/photoCredit').clearGuestCredits(guestId);
      });
      expect((await restore(event, [row.id])).status).toBe(200);

      expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({ uploader_guest_id: null, credit_name: null, credit_source: null });
      expect(await db('photo_feedback').where({ photo_id: photo.id }).first()).toMatchObject({
        comment_text: 'Mine', guest_id: null, guest_name: null, guest_email: null,
      });
    });

    it('clears a forgotten guest from rows a restore put back after the erasure looked', async () => {
      const event = await mkEvent();
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Finn', email: 'finn@example.com', identifier: 'finn-ident', created_at: now(),
      }).returning('id'));
      const photo = await mkPhoto(event, { uploader_guest_id: guestId, credit_name: 'Finn', credit_source: 'guest', uploaded_by: 'guest' });
      await db('photo_feedback').insert({
        photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'finn-ident',
        guest_id: guestId, guest_name: 'Finn', guest_email: 'finn@example.com',
      });
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);

      // The erasure has cleared the live rows; the restore commits before it reaches the trash.
      await require('../../src/services/feedbackService').anonymizeGuestFeedback(guestId);
      const forget = photoTrash.forgetGuest;
      const spy = jest.spyOn(photoTrash, 'forgetGuest').mockImplementation(async (...args) => {
        spy.mockRestore();
        expect((await restore(event, [row.id])).status).toBe(200);
        return forget(...args);
      });
      await require('../../src/services/photoCredit').clearGuestCredits(guestId);

      expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({ uploader_guest_id: null, credit_name: null, credit_source: null });
      expect(await db('photo_feedback').where({ photo_id: photo.id }).first()).toMatchObject({ guest_id: null, guest_name: null, guest_email: null });
    });

    it('does not bring back what the snapshot holds of a guest who is marked deleted', async () => {
      const event = await mkEvent();
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Gus', email: 'gus@example.com', identifier: 'gus-ident', created_at: now(),
      }).returning('id'));
      const photo = await mkPhoto(event, { uploader_guest_id: guestId, credit_name: 'Gus', credit_source: 'guest', uploaded_by: 'guest' });
      await db('photo_feedback').insert({
        photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'gus-ident',
        guest_id: guestId, guest_name: 'Gus', guest_email: 'gus@example.com',
      });
      expect((await del(event, photo)).status).toBe(200);
      await db('gallery_guests').where({ id: guestId }).update({ is_deleted: true, name: 'Removed', email: null });

      expect((await restore(event, [(await trashRowOf(photo.id)).id])).status).toBe(200);
      expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({ uploader_guest_id: null, credit_name: null });
      expect(await db('photo_feedback').where({ photo_id: photo.id }).first()).toMatchObject({ guest_id: null, guest_name: null, guest_email: null });
    });

    it('leaves a file it never put at the destination when a restore crashed before moving', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      const row = await trashRowOf(photo.id);
      // Claimed, then the crash; meanwhile a file with that name waits in the folder for import.
      await age(row.id, 'restoring');
      await storage.put(photo.key, Buffer.from('somebody else, awaiting import'));

      await photoTrash.purgeExpired();
      expect(bytes(photo.key)).toBe('somebody else, awaiting import');
      expect(await storage.exists(row.trash_key)).toBe(true);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });

      // And a restore refuses while that file is there.
      const res = await restore(event, [row.id]);
      expect(res.status).toBe(409);
      expect(res.body.failed[0].code).toBe('RESTORE_TARGET_EXISTS');
      expect(bytes(photo.key)).toBe('somebody else, awaiting import');
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
    });

    it('lets one of two restores into the same place through', async () => {
      const event = await mkEvent();
      const first = await mkPhoto(event);
      expect((await del(event, first)).status).toBe(200);
      // A second photo under the same name, deleted too.
      await storage.put(first.key, Buffer.from('second'));
      const secondId = firstId(await db('photos').insert({
        event_id: event.id, filename: first.filename, path: `${event.slug}/${first.filename}`, type: 'individual',
        uploaded_at: now(), processing_status: 'complete',
      }).returning('id'));
      expect((await del(event, { id: secondId })).status).toBe(200);
      const rows = await db('photo_trash').where({ event_id: event.id }).orderBy('id');
      expect(rows).toHaveLength(2);

      const eventRow = await db('events').where({ id: event.id }).first();
      const results = await Promise.allSettled(rows.map((row) => photoTrash.restorePhoto(eventRow, row)));
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
      // Whatever was not restored is still whole in the trash.
      for (const row of await db('photo_trash').where({ event_id: event.id })) {
        expect(row.state).toBe('trashed');
        expect(await storage.exists(row.trash_key)).toBe(true);
      }
      expect(await count('photos', { event_id: event.id }) + await count('photo_trash', { event_id: event.id })).toBe(2);
    });

    it('removes its file when the gallery\'s trash is deleted under a trashing', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      // The gallery is deleted between the move and the commit: the rows of its trash go.
      let trashKey;
      const rename = storage.rename.bind(storage);
      const spy = jest.spyOn(storage, 'rename').mockImplementation(async (from, to) => {
        spy.mockRestore();
        trashKey = to;
        await rename(from, to);
        await db('photo_trash').where({ event_id: event.id }).del();
      });
      const res = await del(event, photo);
      expect(res.status).toBe(409);
      expect(await storage.exists(trashKey)).toBe(false);
      expect(await count('photo_trash', { event_id: event.id })).toBe(0);
    });

    it('steps back when the sweep took its trashing over', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      // The request stalls after its move; the sweep judges it dead and undoes it.
      const rename = storage.rename.bind(storage);
      const spy = jest.spyOn(storage, 'rename').mockImplementation(async (...args) => {
        spy.mockRestore();
        await rename(...args);
        await age((await trashRowOf(photo.id)).id, 'pending');
        await photoTrash.purgeExpired();
      });
      const res = await del(event, photo);
      expect(res.status).toBe(409);
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      expect(await storage.exists(photo.key)).toBe(true);
      expect(await trashRowOf(photo.id)).toBeUndefined();
    });
  });

  describe('backups', () => {
    it('require the original of a photo at rest in the trash, not one that is moving or about to be purged', async () => {
      const recovery = require('../../src/services/recoveryFiles');
      const event = await mkEvent();
      const [atRest, moving, expiring] = [await mkPhoto(event), await mkPhoto(event), await mkPhoto(event)];
      for (const photo of [atRest, moving, expiring]) expect((await del(event, photo)).status).toBe(200);
      const rows = await Promise.all([atRest, moving, expiring].map((photo) => trashRowOf(photo.id)));
      await db('photo_trash').where({ id: rows[1].id }).update({ state: 'restoring' });
      await db('photo_trash').where({ id: rows[2].id }).update({ purge_after: new Date(Date.now() + 3600000).toISOString() });

      const required = await recovery.requiredKeys(db, () => true);
      expect(required.has(rows[0].trash_key)).toBe(true);
      expect(required.has(rows[1].trash_key)).toBe(false);
      expect(required.has(rows[2].trash_key)).toBe(false);
      // The same from the rows a portable export captured.
      const captured = new Map([['photo_trash', await db('photo_trash').where({ event_id: event.id })]]);
      expect([...await recovery.requiredKeys(captured, () => true)]).toEqual([rows[0].trash_key]);
      await db('photo_trash').where({ id: rows[1].id }).update({ state: 'trashed' });
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
    let backend; let objects; let calls; let etagOf;

    beforeAll(() => {
      const S3StorageBackend = require('../../src/services/storage/S3StorageBackend');
      backend = new S3StorageBackend({ bucket: 'test', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
      objects = new Map();
      calls = [];
      // Every write gets its own ETag, a copy too: what S3 does for an
      // object that was uploaded in parts, which a camera original is.
      const etags = new Map();
      let writes = 0;
      const put = objects.set.bind(objects);
      objects.set = (key, value) => { etags.set(key, `"etag-${writes += 1}"`); return put(key, value); };
      etagOf = (key) => etags.get(key);
      const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      // The adapter's surface the trash may use. Reading an object's body is
      // recorded: a move never does (the `calls` a test compares show it),
      // only the recovery that has to tell two objects apart.
      backend.adapter = {
        bucket: 'test',
        s3Client: {
          send: async (command) => {
            const key = command.input.Key;
            if (!objects.has(key)) throw notFound();
            return { ContentLength: objects.get(key).length, ETag: etagOf(key) };
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
        downloadStream: async (key) => {
          calls.push(['read', key]);
          if (!objects.has(key)) throw notFound();
          return require('stream').Readable.from([objects.get(key)]);
        },
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

    it('removes its copy when a restore fails between copy and delete', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);

      const remove = backend.adapter.delete;
      backend.adapter.delete = async (key) => {
        if (key === row.trash_key) { backend.adapter.delete = remove; throw new Error('S3 is down'); }
        return remove(key);
      };
      let res;
      try {
        res = await restore(event, [row.id]);
      } finally {
        backend.adapter.delete = remove;
      }
      expect(res.status).toBe(409);
      // Nothing left for the importer to publish, and the photo is whole in the trash.
      expect(objects.has(photo.key)).toBe(false);
      expect(objects.has(row.trash_key)).toBe(true);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed', restore_move_at: null });
      expect(await db('photos').where({ id: photo.id }).first()).toBeUndefined();

      expect((await restore(event, [row.id])).status).toBe(200);
      expect(objects.has(photo.key)).toBe(true);
    });

    it('keeps a restore it could not clean up for the sweep, which removes the copy', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);

      const remove = backend.adapter.delete;
      backend.adapter.delete = async () => { throw new Error('S3 is down'); };
      try {
        expect((await restore(event, [row.id])).status).toBe(409);
      } finally {
        backend.adapter.delete = remove;
      }
      // Both objects exist; the row still says so.
      expect(objects.has(photo.key)).toBe(true);
      expect(objects.has(row.trash_key)).toBe(true);
      const stuck = await trashRowOf(photo.id);
      expect(stuck.state).toBe('restoring');
      expect(stuck.restore_move_at).toBeTruthy();
      expect(await photoTrash.claimsIncomingFile(photo.key)).toBe(true);

      await db('photo_trash').where({ id: row.id }).update({ state_changed_at: new Date(Date.now() - 3600000).toISOString() });
      await photoTrash.purgeExpired();
      expect(objects.has(photo.key)).toBe(false);
      expect(objects.has(row.trash_key)).toBe(true);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed', restore_move_at: null });
    });

    it('does not delete an object at the destination that a crashed restore never copied', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);
      // Claimed and crashed before anything moved; an object waits there for the bucket import.
      await db('photo_trash').where({ id: row.id })
        .update({ state: 'restoring', state_changed_at: new Date(Date.now() - 3600000).toISOString() });
      objects.set(photo.key, Buffer.from('awaiting import'));

      await photoTrash.purgeExpired();
      expect(objects.get(photo.key).toString()).toBe('awaiting import');
      expect(objects.has(row.trash_key)).toBe(true);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
    });

    it('does not delete the original after the sweep took a stalled trashing over', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      // Stalls between copy and delete; the sweep undoes the trashing meanwhile.
      const copy = backend.adapter.copy;
      backend.adapter.copy = async (...args) => {
        backend.adapter.copy = copy;
        await copy(...args);
        await db('photo_trash').where({ photo_id: photo.id })
          .update({ state_changed_at: new Date(Date.now() - 3600000).toISOString() });
        await photoTrash.purgeExpired();
      };
      let res;
      try {
        res = await del(event, photo);
      } finally {
        backend.adapter.copy = copy;
      }
      expect(res.status).toBe(409);
      expect(objects.has(photo.key)).toBe(true);
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      expect(await trashRowOf(photo.id)).toBeUndefined();
    });

    it('removes a trash copy that arrives after the sweep gave the trashing up', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      // The copy runs past the stale threshold: the sweep sees no copy and drops the pending row.
      const copy = backend.adapter.copy;
      let trashKey;
      backend.adapter.copy = async (src, dst) => {
        backend.adapter.copy = copy;
        trashKey = dst;
        await db('photo_trash').where({ photo_id: photo.id })
          .update({ state_changed_at: new Date(Date.now() - 3600000).toISOString() });
        await photoTrash.purgeExpired();
        await copy(src, dst);
      };
      let res;
      try {
        res = await del(event, photo);
      } finally {
        backend.adapter.copy = copy;
      }
      expect(res.status).toBe(409);
      expect(objects.has(photo.key)).toBe(true);
      expect(objects.has(trashKey)).toBe(false);
      expect(await db('photos').where({ id: photo.id }).first()).toBeDefined();
      expect(await trashRowOf(photo.id)).toBeUndefined();
    });

    it('takes back a restore copy that arrives after the sweep returned the photo to the trash', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);

      const copy = backend.adapter.copy;
      backend.adapter.copy = async (src, dst) => {
        backend.adapter.copy = copy;
        await db('photo_trash').where({ id: row.id })
          .update({ state_changed_at: new Date(Date.now() - 3600000).toISOString() });
        await photoTrash.purgeExpired();
        expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
        await copy(src, dst);
      };
      let res;
      try {
        res = await restore(event, [row.id]);
      } finally {
        backend.adapter.copy = copy;
      }
      expect(res.status).toBe(409);
      // No object without a row for the importer to publish; the photo is whole in the trash.
      expect(objects.has(photo.key)).toBe(false);
      expect(objects.has(row.trash_key)).toBe(true);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed', restore_move_at: null });
      expect(await photoTrash.claimsIncomingFile(photo.key)).toBe(false);

      expect((await restore(event, [row.id])).status).toBe(200);
      expect(objects.has(photo.key)).toBe(true);
    });

    it('does not let the bucket import publish an object a restore has just put back', async () => {
      const importer = require('../../src/services/s3AutoImporter').__test;
      const event = await mkEvent();
      const photo = await mkPhoto(event, { visibility: 'hidden' });
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);
      webhookFire.mockClear();

      // The importer has listed the object and read which paths have a row;
      // the restore commits before it gets to this one.
      importer.previousSnapshot.set(event.id, new Set([photo.key]));
      const listing = { list: async () => [{ key: photo.key, size: 10 }] };
      const claims = photoTrash.claimsIncomingFile;
      const spy = jest.spyOn(photoTrash, 'claimsIncomingFile').mockImplementation(async (key) => {
        spy.mockRestore();
        expect((await restore(event, [row.id])).status).toBe(200);
        return claims(key);
      });
      try {
        await importer.processEvent(event, listing);
      } finally {
        spy.mockRestore();
        importer.previousSnapshot.delete(event.id);
      }
      const rows = await db('photos').where({ event_id: event.id });
      expect(rows.map((p) => [p.id, p.visibility])).toEqual([[photo.id, 'hidden']]);
      expect(webhookFire).not.toHaveBeenCalled();
    });

    it('keeps the saved original when another object of the same size took its place after a crash', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const original = objects.get(photo.key);
      const tag = etagOf(photo.key);
      // Copied, source deleted, crash. Then an object of the same length arrives under the name.
      const trashKey = `trash/${event.id}/same-size/${photo.filename}`;
      objects.set(trashKey, original);
      objects.delete(photo.key);
      const rowId = firstId(await db('photo_trash').insert({
        photo_id: photo.id, event_id: event.id, state: 'pending',
        state_changed_at: new Date(Date.now() - 3600000).toISOString(), filename: photo.filename,
        original_key: photo.key, trash_key: trashKey, deleted_at: now(), purge_after: new Date(Date.now() + 86400000).toISOString(),
        move_tag: tag, photo_row: JSON.stringify(await db('photos').where({ id: photo.id }).first()), children: '{}',
      }).returning('id'));
      const replacement = Buffer.from('x'.repeat(original.length));
      objects.set(photo.key, replacement);

      await photoTrash.purgeExpired();
      // Neither object is deleted: the photo is in the trash, the newcomer waits for the import.
      expect(objects.get(trashKey)).toBe(original);
      expect(objects.get(photo.key)).toBe(replacement);
      expect(await db('photo_trash').where({ id: rowId }).first()).toMatchObject({ state: 'trashed' });
    });

    it('leaves an object of the same size that is not the copy a crashed restore made', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);
      // The restore noted it was moving and crashed before its copy landed.
      await db('photo_trash').where({ id: row.id }).update({
        state: 'restoring', state_changed_at: new Date(Date.now() - 3600000).toISOString(), restore_move_at: now(),
      });
      const foreign = Buffer.from('y'.repeat(objects.get(row.trash_key).length));
      objects.set(photo.key, foreign);

      await photoTrash.purgeExpired();
      expect(objects.get(photo.key)).toBe(foreign);
      expect(objects.has(row.trash_key)).toBe(true);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed', move_tag: null });
    });

    it('keeps the source of a restore whose copy it cannot identify, and takes the copy back', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);

      // The HEAD after the copy fails: there is no ETag to note.
      const send = backend.adapter.s3Client.send;
      let copied = false;
      const copy = backend.adapter.copy;
      backend.adapter.copy = async (...args) => { await copy(...args); copied = true; };
      backend.adapter.s3Client.send = async (command) => {
        if (copied && command.input.Key === photo.key) { copied = false; throw new Error('HEAD timed out'); }
        return send(command);
      };
      let res;
      try {
        res = await restore(event, [row.id]);
      } finally {
        backend.adapter.s3Client.send = send;
        backend.adapter.copy = copy;
      }
      expect(res.status).toBe(409);
      // The source was not deleted, and the copy, identical byte for byte, is gone again.
      expect(objects.has(row.trash_key)).toBe(true);
      expect(objects.has(photo.key)).toBe(false);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed', move_tag: null });

      expect((await restore(event, [row.id])).status).toBe(200);
      expect(objects.has(photo.key)).toBe(true);
    });

    it('removes the copy of a restore that crashed before it could note it', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).body).toMatchObject({ trashed: 1 });
      const row = await trashRowOf(photo.id);
      // Marked as moving, copied, crash: both objects, no ETag on the row.
      objects.set(photo.key, objects.get(row.trash_key));
      await db('photo_trash').where({ id: row.id }).update({
        state: 'restoring', state_changed_at: new Date(Date.now() - 3600000).toISOString(), restore_move_at: now(),
      });

      await photoTrash.purgeExpired();
      expect(objects.has(photo.key)).toBe(false);
      expect(objects.has(row.trash_key)).toBe(true);
      expect(await trashRowOf(photo.id)).toMatchObject({ state: 'trashed' });
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
        // The trashing noted which object it was about to copy.
        move_tag: etagOf(photo.key),
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
