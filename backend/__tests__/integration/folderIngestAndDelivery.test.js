/**
 * Folder ingest (issue 1786) and two-stage delivery (issue 1562).
 *
 *   - external import mirrors subfolders when the event's folder structure is
 *     on, keeps same-named files in different subfolders apart, and treats a
 *     top-level FirstLook folder as a marker (flag + partial, no folder)
 *   - with folder structure off the import stays flat, first look included
 *   - upload placement maps a folder sent as category_id to folder_id and a
 *     folder request to its fallback folder
 *   - delivery: a first look never re-opens a completed gallery; completion
 *     is explicit, moves the badge to full-set copies, reports duplicates,
 *     queues gallery_completed; the reminder pass sends once soon, once overdue
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('folder ingest and two-stage delivery', () => {
  let tmpDir; let db; let app; let mediaRoot; let cleanup;
  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  const touch = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, `bytes-of-${rel}`);
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-ingest-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = 'ingest-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
      userHasAllPermissions: async () => true,
      userHasAnyPermission: async () => true,
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/services/isolatedSharp', () => () => ({ metadata: async () => ({ width: 100, height: 200 }) }));
    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'),
      ensureThumbnail: jest.fn(),
      extractCaptureDate: jest.fn(async () => null),
      orientedDimensions: (m) => ({ width: m.width, height: m.height }),
    }));

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
    app.use('/api/admin', require('../../src/routes/adminDelivery'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent(columns = {}) {
    const slug = `ev-${Math.random().toString(36).slice(2, 8)}`;
    return idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Event ${slug}`, event_date: '2026-07-03',
      host_email: 'customer@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/t`, share_token: slug,
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
      ...columns,
    }).returning('id'));
  }

  const runImport = (eventId, externalPath) => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path: externalPath, recursive: true });

  describe('external import', () => {
    it('mirrors subfolders, keeps same names apart, and consumes a FirstLook folder', async () => {
      const root = `trip-${Date.now()}`;
      await touch(`${root}/Friday/Activity A/IMG_0001.jpg`);
      await touch(`${root}/Saturday/IMG_0001.jpg`);
      await touch(`${root}/Wedding (FirstLook)/best.jpg`);
      await touch(`${root}/loose.jpg`);
      const eventId = await seedEvent({ source_mode: 'reference', folder_structure: 1 });

      const res = await runImport(eventId, root);
      expect(res.status).toBe(200);

      const photos = await db('photos').where('event_id', eventId).select('filename', 'folder_id', 'first_look', 'external_relpath');
      expect(photos).toHaveLength(4);
      const folders = await db('photo_categories').where('event_id', eventId).select('id', 'name', 'parent_id');
      expect(folders.map((f) => f.name).sort()).toEqual(['Activity A', 'Friday', 'Saturday']);
      const byName = Object.fromEntries(folders.map((f) => [f.name, f]));
      expect(byName['Activity A'].parent_id).toBe(byName.Friday.id);
      const byPath = Object.fromEntries(photos.map((p) => [p.external_relpath.split(path.sep).slice(1).join('/'), p]));
      expect(byPath['Friday/Activity A/IMG_0001.jpg'].folder_id).toBe(byName['Activity A'].id);
      expect(byPath['Saturday/IMG_0001.jpg'].folder_id).toBe(byName.Saturday.id);
      expect(byPath['Wedding (FirstLook)/best.jpg'].folder_id).toBeNull();
      expect(Boolean(byPath['Wedding (FirstLook)/best.jpg'].first_look)).toBe(true);
      expect(byPath['loose.jpg'].folder_id).toBeNull();

      const event = await db('events').where('id', eventId).first();
      expect(event.delivery_status).toBe('partial');
      expect(event.delivery_due_source).toBe('default');

      // A rescan creates nothing new and moves nothing.
      await db('photos').where({ event_id: eventId }).whereNotNull('folder_id').update({ folder_id: null });
      await runImport(eventId, root);
      expect(Number((await db('photos').where('event_id', eventId).whereNotNull('folder_id').count('id as c').first()).c)).toBe(0);
      expect(Number((await db('photo_categories').where('event_id', eventId).count('id as c').first()).c)).toBe(3);
    });

    it('stays flat with folder structure off, but still flags the first look', async () => {
      const root = `flat-${Date.now()}`;
      await touch(`${root}/Friday/a.jpg`);
      await touch(`${root}/FirstLook/b.jpg`);
      const eventId = await seedEvent({ source_mode: 'reference', folder_structure: 0 });
      await runImport(eventId, root);
      const photos = await db('photos').where('event_id', eventId).select('filename', 'folder_id', 'first_look');
      expect(photos.every((p) => p.folder_id === null)).toBe(true);
      expect(Boolean(photos.find((p) => p.filename === 'b.jpg').first_look)).toBe(true);
      expect(Number((await db('photo_categories').where('event_id', eventId).count('id as c').first()).c)).toBe(0);
    });
  });

  it('keeps a first-look photo and the full-set photo of the same name apart in a flat import', async () => {
    const root = `pair-${Date.now()}`;
    await touch(`${root}/FirstLook/IMG_1.jpg`);
    await touch(`${root}/IMG_1.jpg`);
    const eventId = await seedEvent({ source_mode: 'reference', folder_structure: 0 });
    await runImport(eventId, root);
    const rows = await db('photos').where('event_id', eventId).select('first_look');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Boolean(r.first_look)).sort()).toEqual([false, true]);
  });

  describe('upload placement', () => {
    it('maps a folder sent as category_id to folder_id and a request to its fallback', async () => {
      const eventId = await seedEvent();
      const tree = require('../../src/services/folderTreeService');
      const { resolveUploadPlacement } = require('../../src/services/uploadPlacement');
      const { folderId } = await tree.ensurePath(eventId, ['Saturday']);
      const filter = idOf(await db('photo_categories').insert({ name: 'Portraits', slug: `p-${eventId}`, is_global: 0, event_id: eventId }).returning('id'));

      expect((await resolveUploadPlacement(eventId, { category_id: String(folderId) })).placement)
        .toMatchObject({ category_id: null, folder_id: folderId });
      expect((await resolveUploadPlacement(eventId, { category_id: filter, folder_id: folderId, first_look: 'true' })).placement)
        .toMatchObject({ category_id: filter, folder_id: folderId, first_look: true });

      const requestId = await require('../../src/services/folderRequestService').openRequest(eventId, ['Saturday', 'B'], folderId, 1);
      expect((await resolveUploadPlacement(eventId, { folder_request_id: requestId })).placement)
        .toMatchObject({ folder_id: folderId, pending_folder_request_id: requestId });

      const other = await seedEvent();
      expect((await resolveUploadPlacement(other, { folder_id: folderId })).error).toBeTruthy();
    });
  });

  describe('delivery', () => {
    const delivery = () => require('../../src/services/deliveryService');

    it('a first look switches to partial once and never re-opens a completed gallery', async () => {
      const eventId = await seedEvent();
      expect(await delivery().markFirstLookArrived(eventId)).toBe(true);
      expect(await delivery().markFirstLookArrived(eventId)).toBe(false);
      await db('events').where('id', eventId).update({ delivery_status: 'complete', delivery_completed_at: new Date().toISOString() });
      expect(await delivery().markFirstLookArrived(eventId)).toBe(false);
      expect((await db('events').where('id', eventId).first()).delivery_status).toBe('complete');
    });

    it('completing moves the badge onto full-set copies, reports duplicates and queues the mail', async () => {
      const eventId = await seedEvent({ delivery_status: 'partial', delivery_expected_count: 80 });
      const mk = async (filename, firstLook, extra = {}) => idOf(await db('photos').insert({
        event_id: eventId, filename, original_filename: filename, path: `x/${filename}`, type: 'individual', first_look: firstLook ? 1 : 0, ...extra,
      }).returning('id'));
      const shot = { captured_at: '2026-07-03T10:15:42.000Z' };
      const flDup = await mk('IMG_1.jpg', true, shot);
      const flOnly = await mk('IMG_2.jpg', true);
      const full = await mk('img_1.JPG', false, shot);

      const res = await request(app).post(`/api/admin/events/${eventId}/delivery/complete`).send({});
      expect(res.status).toBe(200);
      expect(res.body.duplicate_photo_ids).toEqual([flDup]);
      expect(res.body.email_queued).toBe(true);
      expect(Boolean((await db('photos').where('id', full).first()).first_look)).toBe(true);
      expect(Boolean((await db('photos').where('id', flOnly).first()).first_look)).toBe(true);
      const event = await db('events').where('id', eventId).first();
      expect(event.delivery_status).toBe('complete');
      expect(event.delivery_completed_at).toBeTruthy();
      const mail = await db('email_queue').where({ event_id: eventId, email_type: 'gallery_completed' }).first();
      expect(mail.recipient_email).toBe('customer@example.com');

      const again = await request(app).post(`/api/admin/events/${eventId}/delivery/complete`).send({});
      expect(again.status).toBe(409);
    });

    // Review of PR 1826, blocker 1: camera names repeat across folders, and a
    // wrong pair deletes a unique photo.
    describe('duplicate pairing', () => {
      const pairsFor = async (photos) => {
        const eventId = await seedEvent({ delivery_status: 'partial' });
        const ids = {};
        for (const [key, row] of Object.entries(photos)) {
          ids[key] = idOf(await db('photos').insert({
            event_id: eventId, filename: row.name, original_filename: row.name, path: `x/${key}`, type: 'individual',
            first_look: row.fl ? 1 : 0, captured_at: row.at || null, width: row.w || null, height: row.h || null, size_bytes: row.size || null,
          }).returning('id'));
        }
        return { pairs: await delivery().findFirstLookDuplicates(eventId), ids };
      };
      const at = '2026-07-03T10:15:42.000Z';

      it('never pairs a name that occurs twice in the full set', async () => {
        const { pairs } = await pairsFor({
          fl: { name: 'IMG_0001.jpg', fl: true, at },
          friday: { name: 'IMG_0001.jpg', at },
          saturday: { name: 'IMG_0001.jpg', at: '2026-07-04T09:00:00.000Z' },
        });
        expect(pairs).toEqual([]);
      });

      it('never pairs a name that occurs twice among the first look', async () => {
        const { pairs } = await pairsFor({
          a: { name: 'IMG_0001.jpg', fl: true, at }, b: { name: 'IMG_0001.jpg', fl: true, at }, full: { name: 'IMG_0001.jpg', at },
        });
        expect(pairs).toEqual([]);
      });

      it('needs the capture time to agree when both have one', async () => {
        const { pairs } = await pairsFor({
          fl: { name: 'IMG_0001.jpg', fl: true, at }, full: { name: 'IMG_0001.jpg', at: '2026-07-04T09:00:00.000Z' },
        });
        expect(pairs).toEqual([]);
      });

      it('falls back to identical dimensions and size without capture times, never to the name alone', async () => {
        const same = await pairsFor({
          fl: { name: 'a.jpg', fl: true, w: 6000, h: 4000, size: 123 }, full: { name: 'a.jpg', w: 6000, h: 4000, size: 123 },
        });
        expect(same.pairs).toEqual([{ first_look_id: same.ids.fl, full_id: same.ids.full }]);
        const nameOnly = await pairsFor({ fl: { name: 'b.jpg', fl: true }, full: { name: 'b.jpg' } });
        expect(nameOnly.pairs).toEqual([]);
      });
    });

    it('re-entering partial starts a fresh promise: stamps cleared, a past due date replaced', async () => {
      const eventId = await seedEvent({
        delivery_status: 'complete',
        delivery_due_at: '2020-01-01T12:00:00.000Z',
        delivery_reminder_sent_at: '2020-01-01T00:00:00.000Z',
        delivery_overdue_notified_at: '2020-01-02T00:00:00.000Z',
      });
      expect(await delivery().markFirstLookArrived(eventId)).toBe(true);
      const ev = await db('events').where('id', eventId).first();
      expect(ev.delivery_reminder_sent_at).toBeNull();
      expect(ev.delivery_overdue_notified_at).toBeNull();
      expect(Date.parse(ev.delivery_due_at)).toBeGreaterThan(Date.parse('2020-01-01T12:00:00.000Z'));
    });

    it('computes the default due date from a DATE column that arrives as a Date (Postgres)', async () => {
      const due = await delivery().defaultDueAt({ event_date: new Date('2026-07-03T00:00:00.000Z') });
      expect(due.toISOString().slice(0, 10)).toBe('2026-07-10');
    });

    it('two completions racing each other notify once', async () => {
      const eventId = await seedEvent({ delivery_status: 'partial' });
      const results = await Promise.all([delivery().completeDelivery(eventId), delivery().completeDelivery(eventId)]);
      expect(results.filter((r) => !r.already)).toHaveLength(1);
    });

    it('the guest block caps placeholders and is null for an ordinary gallery', () => {
      const { guestDeliveryPayload } = delivery();
      expect(guestDeliveryPayload({ delivery_status: 'complete' }, 10)).toBeNull();
      const partial = guestDeliveryPayload({ delivery_status: 'partial', delivery_expected_count: 240, delivery_due_at: '2026-07-12T12:00:00Z' }, 166);
      expect(partial).toMatchObject({ status: 'partial', placeholder_count: 12, delivered_count: 166, expected_count: 240 });
      const done = guestDeliveryPayload({ delivery_status: 'complete', delivery_completed_at: '2026-07-10' }, 240);
      expect(done).toMatchObject({ status: 'complete', placeholder_count: 0, due_at: null });
    });

    it('the reminder pass mails once when due soon and once more when overdue', async () => {
      const due = new Date(Date.now() + 6 * 3600e3);
      const eventId = await seedEvent({ delivery_status: 'partial', delivery_due_at: due.toISOString() });
      const count = async () => Number((await db('email_queue').where({ event_id: eventId, email_type: 'delivery_due_reminder' }).count('id as c').first()).c);
      await delivery().runDeliveryReminderPass();
      await delivery().runDeliveryReminderPass();
      expect(await count()).toBe(1);
      // Still the promised day: not overdue yet (review of PR 1826, concern 13).
      await delivery().runDeliveryReminderPass({ now: new Date(due.getTime() + 3600e3) });
      expect(await count()).toBe(1);
      const dayAfter = new Date(`${due.toISOString().slice(0, 10)}T23:59:59.999Z`).getTime() + 3600e3;
      await delivery().runDeliveryReminderPass({ now: new Date(dayAfter) });
      await delivery().runDeliveryReminderPass({ now: new Date(dayAfter + 3600e3) });
      expect(await count()).toBe(2);
    });

    it('does not claim a reminder it cannot send, so an address added later still gets it', async () => {
      await db('business_profile').update({ email: null });
      const due = new Date(Date.now() + 6 * 3600e3);
      const eventId = await seedEvent({ delivery_status: 'partial', delivery_due_at: due.toISOString(), admin_email: '' });
      await delivery().runDeliveryReminderPass();
      expect((await db('events').where('id', eventId).first()).delivery_reminder_sent_at).toBeNull();
      await db('events').where('id', eventId).update({ admin_email: 'studio@example.com' });
      await delivery().runDeliveryReminderPass();
      expect(Number((await db('email_queue').where({ event_id: eventId, email_type: 'delivery_due_reminder' }).count('id as c').first()).c)).toBe(1);
    });
  });
});
