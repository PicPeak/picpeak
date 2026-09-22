/**
 * Photo credits / uploader names (issue 1561).
 *
 * Pins the contract:
 *  - a guest upload records who ran it (uploaded_by 'guest', which the queued
 *    path used to leave at its 'admin' default) and, when the event asks for
 *    names, the guest identity's name as a `guest` credit
 *  - `required` refuses a nameless upload before any file is stored; `off`
 *    records no name whatever the request carries; a guest token minted for
 *    another gallery names nobody
 *  - registration works for uploads with feedback off, and stays refused when
 *    neither feature needs an identity
 *  - guests see names only with the per-event switch on; the PIN client always;
 *    the slideshow never
 *  - admin uploads read the EXIF credit in the worker, guest uploads never do,
 *    and a manual credit survives both the worker and the backfill
 *  - removing a guest (admin delete or forget-me) takes their name off their
 *    photos; a merge moves the uploads to the survivor's name
 *  - the admin list, filter, names endpoint, CSV/JSON export and XMP carry it
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'photo-credits-test-secret';

describe('Photo credits (issue 1561)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken;
  let plainJpeg;
  let artistJpeg;
  let slugCounter = 0;

  const galleryToken = (event, extra = {}) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent(overrides = {}) {
    slugCounter += 1;
    const slug = `credit-test-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Credit Test ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `credit-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_user_uploads: 1,
      guest_name_mode: 'optional',
      created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'events', 'active', slug), { recursive: true });
    const event = await db('events').where({ id }).first();
    return { event, token: galleryToken(event) };
  }

  async function addPhoto(event, fields = {}, bytes = plainJpeg) {
    const filename = `p-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    await fs.promises.writeFile(path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug, filename), bytes);
    const r = await db('photos').insert({
      event_id: event.id,
      filename,
      path: `${event.slug}/${filename}`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      size_bytes: bytes.length,
      uploaded_at: new Date().toISOString(),
      ...fields,
    }).returning('id');
    return r[0]?.id ?? r[0];
  }

  async function register(event, token, name) {
    const res = await request(app)
      .post(`/api/gallery/${event.slug}/guest`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name });
    return res;
  }

  function upload(event, token, guestToken) {
    const req = request(app)
      .post(`/api/gallery/${event.id}/upload`)
      .set('Authorization', `Bearer ${token}`);
    if (guestToken) req.set('x-guest-token', guestToken);
    return req.attach('photos', plainJpeg, { filename: 'guest.jpg', contentType: 'image/jpeg' });
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const base = sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg();
    plainJpeg = await base.clone().toBuffer();
    artistJpeg = await base.clone().withExif({ IFD0: { Artist: 'Studio Lumen' } }).toBuffer();

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'credit-admin',
      email: 'credit-admin@example.com',
      password_hash: await bcrypt.hash('CreditAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'credit-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin', require('../../src/routes/adminGuests'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  const admin = (req) => req.set('Cookie', [`admin_token=${adminToken}`]).set('Authorization', `Bearer ${adminToken}`);

  describe('guest upload', () => {
    it('records the guest name, the identity and uploaded_by guest', async () => {
      const { event, token } = await makeEvent();
      const reg = await register(event, token, 'Anna');
      expect(reg.status).toBe(200);

      const res = await upload(event, token, reg.body.token);
      expect(res.status).toBe(202);
      const row = await db('photos').where({ id: res.body.photo_ids[0] }).first();
      expect(row).toMatchObject({
        uploaded_by: 'guest',
        credit_name: 'Anna',
        credit_source: 'guest',
        uploader_guest_id: reg.body.guest.id,
      });
    });

    it('optional mode accepts a nameless upload, still as a guest upload', async () => {
      const { event, token } = await makeEvent();
      const res = await upload(event, token);
      expect(res.status).toBe(202);
      const row = await db('photos').where({ id: res.body.photo_ids[0] }).first();
      expect(row.uploaded_by).toBe('guest');
      expect(row.credit_name).toBeNull();
      expect(row.credit_source).toBeNull();
    });

    it('required mode refuses a nameless upload before storing anything', async () => {
      const { event, token } = await makeEvent({ guest_name_mode: 'required' });
      const res = await upload(event, token);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UPLOADER_NAME_REQUIRED');
      const count = await db('photos').where({ event_id: event.id }).count('id as c').first();
      expect(Number(count.c)).toBe(0);
    });

    it('a guest token from another gallery names nobody', async () => {
      const { event: other, token: otherToken } = await makeEvent();
      const reg = await register(other, otherToken, 'Mallory');
      const { event, token } = await makeEvent({ guest_name_mode: 'required' });
      const res = await upload(event, token, reg.body.token);
      expect(res.status).toBe(400);
    });

    it('off records no name, whatever the request carries', async () => {
      const { event: named, token: namedToken } = await makeEvent();
      const reg = await register(named, namedToken, 'Anna');
      // Same event, switched off after the guest registered.
      await db('events').where({ id: named.id }).update({ guest_name_mode: 'off' });
      const res = await upload(named, namedToken, reg.body.token);
      expect(res.status).toBe(202);
      const row = await db('photos').where({ id: res.body.photo_ids[0] }).first();
      expect(row.uploaded_by).toBe('guest');
      expect(row.credit_name).toBeNull();
      expect(row.uploader_guest_id).toBeNull();
    });

    it('sanitises the name the guest registers', async () => {
      const { event, token } = await makeEvent();
      const reg = await register(event, token, 'An\u202Ena <b>\u200B');
      expect(reg.status).toBe(200);
      expect(reg.body.guest.name).toBe('Anna b');
    });
  });

  describe('guest registration gate', () => {
    it('allows registration for uploader names with feedback off', async () => {
      const { event, token } = await makeEvent();
      expect((await register(event, token, 'Bea')).status).toBe(200);
    });

    it('stays refused when neither feedback nor uploader names need it', async () => {
      const { event, token } = await makeEvent({ guest_name_mode: 'off' });
      expect((await register(event, token, 'Bea')).status).toBe(403);
      const { event: noUploads, token: t2 } = await makeEvent({ allow_user_uploads: 0 });
      expect((await register(noUploads, t2, 'Bea')).status).toBe(403);
    });
  });

  describe('gallery payload', () => {
    async function photosFor(event, token) {
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      return res.body;
    }

    it('withholds names from guests unless the switch is on', async () => {
      const { event, token } = await makeEvent();
      await addPhoto(event, { credit_name: 'Anna', credit_source: 'guest', uploaded_by: 'guest' });

      let body = await photosFor(event, token);
      expect(body.event.credits_visible).toBe(false);
      expect(body.event.guest_name_mode).toBe('optional');
      expect(body.photos[0]).not.toHaveProperty('credit_name');

      await db('events').where({ id: event.id }).update({ show_credits_to_guests: 1 });
      body = await photosFor(event, token);
      expect(body.event.credits_visible).toBe(true);
      expect(body.photos[0]).toMatchObject({ credit_name: 'Anna', uploaded_by_guest: true });
    });

    it('shows names to the PIN client regardless, and never to the slideshow', async () => {
      const { event } = await makeEvent({ show_credits_to_guests: 0 });
      await addPhoto(event, { credit_name: 'Anna', credit_source: 'guest', uploaded_by: 'guest' });

      const client = await photosFor(event, galleryToken(event, { accessLevel: 'client' }));
      expect(client.photos[0].credit_name).toBe('Anna');

      await db('events').where({ id: event.id }).update({ show_credits_to_guests: 1 });
      const show = await photosFor(event, galleryToken(event, { accessLevel: 'slideshow' }));
      expect(show.event.credits_visible).toBe(false);
      expect(show.photos[0]).not.toHaveProperty('credit_name');
    });
  });

  describe('EXIF credit', () => {
    it('prefers Artist, then XMP creator, then the name inside Copyright', () => {
      // Required here, not in the describe body: that runs at collection time,
      // before beforeAll points db.js at the temp database.
      const { creditFromMetadata } = require('../../src/services/photoCredit');
      expect(creditFromMetadata({ Artist: 'A', creator: 'C', Copyright: 'X' })).toBe('A');
      expect(creditFromMetadata({ creator: ['Cora', 'Dan'], Copyright: 'X' })).toBe('Cora, Dan');
      expect(creditFromMetadata({ Copyright: '© 2026 Studio Lumen. All rights reserved.' })).toBe('Studio Lumen');
      expect(creditFromMetadata({ Artist: '   ', Copyright: '' })).toBeNull();
      // The admin filter's "no credit" token is not a name.
      expect(creditFromMetadata({ Artist: '__none__', creator: 'Cora' })).toBe('Cora');
    });

    it('the worker reads it for an admin upload, never for a guest upload', async () => {
      const { processPhoto } = require('../../src/services/photoProcessor');
      const { event } = await makeEvent();
      const adminId = await addPhoto(event, { processing_status: 'pending', uploaded_by: 'admin' }, artistJpeg);
      const guestId = await addPhoto(event, { processing_status: 'pending', uploaded_by: 'guest' }, artistJpeg);
      const manualId = await addPhoto(event, {
        processing_status: 'pending', uploaded_by: 'admin', credit_source: 'manual', credit_name: null,
      }, artistJpeg);

      await processPhoto(adminId);
      await processPhoto(guestId);
      await processPhoto(manualId);

      expect(await db('photos').where({ id: adminId }).first())
        .toMatchObject({ credit_name: 'Studio Lumen', credit_source: 'exif' });
      expect(await db('photos').where({ id: guestId }).first())
        .toMatchObject({ credit_name: null, credit_source: null });
      expect(await db('photos').where({ id: manualId }).first())
        .toMatchObject({ credit_name: null, credit_source: 'manual' });
    }, 30000);

    it('a replacement re-reads an automatic credit and keeps a manual one', async () => {
      const { replacePhoto } = require('../../src/services/photoReplacementService');
      const { event } = await makeEvent();
      const exifId = await addPhoto(event, { credit_name: 'Old Studio', credit_source: 'exif' });
      const manualId = await addPhoto(event, { credit_name: 'Chosen', credit_source: 'manual' });
      for (const id of [exifId, manualId]) {
        const temp = path.join(process.env.STORAGE_PATH, `replace-${id}.jpg`);
        await fs.promises.writeFile(temp, artistJpeg);
        const existing = await db('photos').where({ id }).first();
        const result = await replacePhoto(existing, temp, { originalFilename: 'new.jpg', mimeType: 'image/jpeg', event });
        expect(result.success).toBe(true);
      }
      expect(await db('photos').where({ id: exifId }).first())
        .toMatchObject({ credit_name: 'Studio Lumen', credit_source: 'exif' });
      expect(await db('photos').where({ id: manualId }).first())
        .toMatchObject({ credit_name: 'Chosen', credit_source: 'manual' });
    });

    it('the backfill fills undecided rows and leaves decided ones alone', async () => {
      const { event } = await makeEvent();
      const open = await addPhoto(event, { uploaded_by: 'admin' }, artistJpeg);
      const guest = await addPhoto(event, { uploaded_by: 'guest' }, artistJpeg);
      const manual = await addPhoto(event, { credit_source: 'manual', credit_name: 'Fixed' }, artistJpeg);

      const res = await admin(request(app).post('/api/admin/photos/repair-credits'));
      expect(res.status).toBe(200);

      const deadline = Date.now() + 15000;
      let state;
      do {
        // eslint-disable-next-line no-await-in-loop
        state = (await admin(request(app).get('/api/admin/photos/repair-credits/status'))).body;
        if (!state.isRunning) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
      } while (Date.now() < deadline);
      expect(state.isRunning).toBe(false);

      expect((await db('photos').where({ id: open }).first()).credit_name).toBe('Studio Lumen');
      expect((await db('photos').where({ id: guest }).first()).credit_name).toBeNull();
      expect((await db('photos').where({ id: manual }).first()).credit_name).toBe('Fixed');
    }, 30000);
  });

  describe('admin surfaces', () => {
    it('lists, filters, counts and corrects credits', async () => {
      const { event } = await makeEvent();
      const a = await addPhoto(event, { credit_name: 'Anna', credit_source: 'guest', uploaded_by: 'guest' });
      await addPhoto(event, { credit_name: 'Anna', credit_source: 'guest', uploaded_by: 'guest' });
      await addPhoto(event, { credit_name: 'Annabel', credit_source: 'guest', uploaded_by: 'guest' });
      await addPhoto(event, {});

      const credits = await admin(request(app).get(`/api/admin/photos/${event.id}/photos/credits`));
      expect(credits.status).toBe(200);
      expect(credits.body).toEqual({
        credits: [{ name: 'Anna', count: 2 }, { name: 'Annabel', count: 1 }],
        none: 1,
      });

      const filtered = await admin(request(app).get(`/api/admin/photos/${event.id}/photos?credit=Anna`));
      expect(filtered.body.photos).toHaveLength(2);
      expect(filtered.body.photos[0]).toMatchObject({ credit_name: 'Anna', credit_source: 'guest', uploaded_by: 'guest' });
      const none = await admin(request(app).get(`/api/admin/photos/${event.id}/photos?credit=__none__`));
      expect(none.body.photos).toHaveLength(1);

      const fix = await admin(request(app).put(`/api/admin/photos/${event.id}/photos/${a}/credit`))
        .send({ credit_name: 'Anna  <Example>' });
      expect(fix.status).toBe(200);
      expect(await db('photos').where({ id: a }).first())
        .toMatchObject({ credit_name: 'Anna Example', credit_source: 'manual' });

      const bad = await admin(request(app).put(`/api/admin/photos/${event.id}/photos/${a}/credit`))
        .send({ credit_name: 42 });
      expect(bad.status).toBe(400);

      const bulk = await admin(request(app).post(`/api/admin/photos/${event.id}/photos/bulk-update`))
        .send({ photoIds: [a], updates: { credit_name: null } });
      expect(bulk.status).toBe(200);
      expect(await db('photos').where({ id: a }).first())
        .toMatchObject({ credit_name: null, credit_source: 'manual' });
    });

    it('exports the credit to CSV, JSON and XMP', async () => {
      const { PhotoExportService } = require('../../src/services/photoExportService');
      const exporter = new PhotoExportService();
      const { event } = await makeEvent();
      await addPhoto(event, { credit_name: 'Anna & Co', credit_source: 'guest' });

      const csv = await exporter.exportPhotos(event.id, null, 'csv');
      expect(csv.content.split('\n')[0].endsWith(',credit')).toBe(true);
      expect(csv.content).toContain('"Anna & Co"');

      const json = await exporter.exportPhotos(event.id, null, 'json');
      expect(JSON.parse(json.content).photos[0].credit).toBe('Anna & Co');

      const photos = await exporter.getPhotosWithFeedback(event.id);
      const xmp = exporter.xmpGenerator.generateXmp(photos[0]);
      expect(xmp).toContain('<dc:creator>');
      expect(xmp).toContain('Anna &amp; Co');
      expect(exporter.xmpGenerator.generateXmp({ ...photos[0], credit_name: null })).not.toContain('dc:creator');
    });
  });

  describe('event settings', () => {
    it('validates and stores the per-event mode and switch', async () => {
      const { event } = await makeEvent({ guest_name_mode: 'off' });
      const bad = await admin(request(app).put(`/api/admin/events/${event.id}`))
        .send({ guest_name_mode: 'always' });
      expect(bad.status).toBe(400);

      const ok = await admin(request(app).put(`/api/admin/events/${event.id}`))
        .send({ guest_name_mode: 'required', show_credits_to_guests: true });
      expect(ok.status).toBe(200);
      const row = await db('events').where({ id: event.id }).first();
      expect(row.guest_name_mode).toBe('required');
      expect(Boolean(row.show_credits_to_guests)).toBe(true);
    });

    it('a new event takes the Event Defaults when the request omits them', async () => {
      const { createEvent } = require('../../src/services/eventCreationService');
      await db('app_settings').insert([
        { setting_key: 'event_default_guest_name_mode', setting_value: JSON.stringify('optional'), setting_type: 'events' },
        { setting_key: 'event_default_show_credits_to_guests', setting_value: JSON.stringify(true), setting_type: 'events' },
      ]);
      try {
        const actor = { id: (await db('admin_users').where({ username: 'credit-admin' }).first()).id };
        const base = {
          event_type: 'wedding', event_date: '2026-09-01', customer_name: 'C', customer_email: 'c@example.com',
          admin_email: 'a@example.com', require_password: false, expiration_days: 30,
        };
        const defaulted = await createEvent({ ...base, event_name: 'Defaults A' }, { actor });
        const explicit = await createEvent({
          ...base, event_name: 'Defaults B', guest_name_mode: 'off', show_credits_to_guests: false,
        }, { actor });
        const a = await db('events').where({ id: defaulted.id }).first();
        const b = await db('events').where({ id: explicit.id }).first();
        expect(a.guest_name_mode).toBe('optional');
        expect(Boolean(a.show_credits_to_guests)).toBe(true);
        expect(b.guest_name_mode).toBe('off');
        expect(Boolean(b.show_credits_to_guests)).toBe(false);
      } finally {
        await db('app_settings')
          .whereIn('setting_key', ['event_default_guest_name_mode', 'event_default_show_credits_to_guests'])
          .del();
      }
    });
  });

  describe('erasure and merge', () => {
    it('admin guest delete and forget-me clear the name from their uploads', async () => {
      const { event, token } = await makeEvent();
      const anna = await register(event, token, 'Anna');
      const bea = await register(event, token, 'Bea');
      const annaPhoto = (await upload(event, token, anna.body.token)).body.photo_ids[0];
      const beaPhoto = (await upload(event, token, bea.body.token)).body.photo_ids[0];

      const del = await admin(request(app).delete(`/api/admin/events/${event.id}/guests/${anna.body.guest.id}`));
      expect(del.status).toBe(200);
      expect(await db('photos').where({ id: annaPhoto }).first())
        .toMatchObject({ credit_name: null, credit_source: null, uploader_guest_id: null, uploaded_by: 'guest' });

      const forget = await request(app)
        .delete(`/api/gallery/${event.slug}/guest/me`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-guest-token', bea.body.token);
      expect(forget.status).toBe(200);
      expect((await db('photos').where({ id: beaPhoto }).first()).credit_name).toBeNull();
    });

    it('an upload that lands after its guest was erased keeps no name', async () => {
      const { event, token } = await makeEvent();
      const anna = await register(event, token, 'Anna');
      const credit = { credit_name: 'Anna', credit_source: 'guest', uploader_guest_id: anna.body.guest.id };
      // Erased while the upload was still transferring.
      await admin(request(app).delete(`/api/admin/events/${event.id}/guests/${anna.body.guest.id}`)).expect(200);
      const [row] = await db('photos').insert({
        event_id: event.id, filename: 'late.jpg', path: `${event.slug}/late.jpg`, type: 'individual',
        uploaded_by: 'guest', uploaded_at: new Date().toISOString(), ...credit,
      }).returning('id');
      const photoId = row?.id ?? row;

      await require('../../src/services/photoCredit').settleGuestCredit(photoId, credit);
      expect(await db('photos').where({ id: photoId }).first())
        .toMatchObject({ credit_name: null, credit_source: null, uploader_guest_id: null });
    });

    it('a merge moves the uploads to the survivor under their name', async () => {
      const { event, token } = await makeEvent();
      const keep = await register(event, token, 'Anna Example');
      const dup = await register(event, token, 'anna');
      const photo = (await upload(event, token, dup.body.token)).body.photo_ids[0];

      const res = await admin(request(app).post(`/api/admin/events/${event.id}/guests/${keep.body.guest.id}/merge`))
        .send({ mergeIds: [dup.body.guest.id] });
      expect(res.status).toBe(200);
      expect(await db('photos').where({ id: photo }).first())
        .toMatchObject({ credit_name: 'Anna Example', uploader_guest_id: keep.body.guest.id });
    });
  });
});
