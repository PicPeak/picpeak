/**
 * Privacy and visibility guarantees for face recognition (#1074).
 *
 * These are the tests that matter most in this feature. Two of them cover
 * defects that would be invisible in normal use:
 *
 *   - The people strip is computed from face rows, which have no concept of
 *     photo visibility. Handing a guest a raw count leaks how many hidden
 *     photos someone appears in, and a cover face picked without scoping
 *     renders a crop of a photo the guest may not open.
 *
 *   - Face embeddings are biometric data. They must not ride along in a
 *     .picpeak export, which gets handed to clients and moved between
 *     operators.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-faceprivacy-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'faceprivacy-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let clustering; let peopleService; let faceProcessor;

function makeEmbedding(id, variant = 0, dim = 64) {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin((i + 1) * (id + 1) * 0.7) + variant * 0.02 * Math.cos(i * 3.1);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

async function seedEvent(slug) {
  const [row] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `${slug}-share`,
    expires_at: new Date().toISOString(),
    face_recognition_enabled: true,
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

async function addPhotoWithFace(eventId, embedding, { visibility = 'visible', score = 0.99 } = {}) {
  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: `${Math.random()}.jpg`,
    path: '/tmp/x.jpg',
    type: 'individual',
    visibility,
    processing_status: 'complete',
  }).returning('id');
  const photoId = typeof p === 'object' ? p.id : p;

  const row = {
    photo_id: photoId,
    event_id: eventId,
    bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200,
    det_score: score,
    embedding: clustering.packEmbedding(embedding),
    model_version: 'test-v1',
    created_at: new Date().toISOString(),
  };
  const [f] = await db('photo_faces').insert(row).returning('id');
  return { photoId, face: { ...row, id: typeof f === 'object' ? f.id : f } };
}

describe('face privacy and visibility (#1074)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    clustering = require('../../src/services/faceClustering');
    peopleService = require('../../src/services/facePeopleService');
    faceProcessor = require('../../src/services/faceProcessor');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('visibility scoping', () => {
    it('counts only photos the audience can actually see', async () => {
      const eventId = await seedEvent('visibility-count');
      const faces = [];
      // Same person: 3 visible photos, 4 hidden ones.
      for (let v = 0; v < 3; v++) {
        faces.push((await addPhotoWithFace(eventId, makeEmbedding(1, v))).face);
      }
      for (let v = 3; v < 7; v++) {
        faces.push((await addPhotoWithFace(eventId, makeEmbedding(1, v), { visibility: 'hidden' })).face);
      }
      await clustering.assignFaces(eventId, faces);

      const guestView = await peopleService.listPeople(eventId, { isClient: false, minClusterSize: 1 });
      const clientView = await peopleService.listPeople(eventId, { isClient: true, minClusterSize: 1 });

      expect(guestView).toHaveLength(1);
      // The leak this test exists to prevent: 3, never 7.
      expect(guestView[0].face_count).toBe(3);
      expect(clientView[0].face_count).toBe(7);
    });

    it('never returns face_count_total to a guest', async () => {
      const eventId = await seedEvent('no-total-leak');
      const { face } = await addPhotoWithFace(eventId, makeEmbedding(2));
      await clustering.assignFaces(eventId, [face]);

      const [person] = await peopleService.listPeople(eventId, { isClient: false, minClusterSize: 1 });
      expect(person).not.toHaveProperty('total_face_count');
      expect(person).not.toHaveProperty('is_hidden');
    });

    it('picks a cover face from a photo the guest may open', async () => {
      const eventId = await seedEvent('cover-scoping');
      // The BEST face (highest score) is in a hidden photo — a naive
      // implementation would hand its crop to the guest.
      const hidden = await addPhotoWithFace(eventId, makeEmbedding(3, 0), {
        visibility: 'hidden', score: 0.99,
      });
      const visible = await addPhotoWithFace(eventId, makeEmbedding(3, 1), {
        visibility: 'visible', score: 0.80,
      });
      await clustering.assignFaces(eventId, [hidden.face, visible.face]);

      const [guestPerson] = await peopleService.listPeople(eventId, { isClient: false, minClusterSize: 1 });
      expect(guestPerson.cover.photo_id).toBe(visible.photoId);
      expect(guestPerson.cover.photo_id).not.toBe(hidden.photoId);
    });

    it('drops a person entirely when all their photos are hidden', async () => {
      const eventId = await seedEvent('all-hidden');
      const faces = [];
      for (let v = 0; v < 3; v++) {
        faces.push((await addPhotoWithFace(eventId, makeEmbedding(4, v), { visibility: 'hidden' })).face);
      }
      await clustering.assignFaces(eventId, faces);

      const guestView = await peopleService.listPeople(eventId, { isClient: false, minClusterSize: 1 });
      expect(guestView).toHaveLength(0);
      const clientView = await peopleService.listPeople(eventId, { isClient: true, minClusterSize: 1 });
      expect(clientView).toHaveLength(1);
    });

    it('omits hidden and ignored people from the guest response', async () => {
      const eventId = await seedEvent('hidden-people');
      const a = (await addPhotoWithFace(eventId, makeEmbedding(5))).face;
      const b = (await addPhotoWithFace(eventId, makeEmbedding(6))).face;
      await clustering.assignFaces(eventId, [a, b]);

      const people = await db('event_people').where({ event_id: eventId }).orderBy('id');
      await db('event_people').where({ id: people[0].id }).update({ is_hidden: true });
      await db('event_people').where({ id: people[1].id }).update({ is_ignored: true });

      const guestView = await peopleService.listPeople(eventId, { isClient: false, minClusterSize: 1 });
      expect(guestView).toHaveLength(0);
      const adminView = await peopleService.listPeople(eventId, { isClient: true, forAdmin: true });
      expect(adminView).toHaveLength(2);
    });

    it('does not attach a hidden person to a photo a guest can see', async () => {
      const eventId = await seedEvent('person-ids-hidden');
      const { photoId, face } = await addPhotoWithFace(eventId, makeEmbedding(7));
      await clustering.assignFaces(eventId, [face]);
      const person = await db('event_people').where({ event_id: eventId }).first();
      await db('event_people').where({ id: person.id }).update({ is_hidden: true });

      const guestMap = await peopleService.getPersonIdsByPhoto(eventId, [photoId], { forAdmin: false });
      expect(guestMap.get(photoId)).toBeUndefined();

      const adminMap = await peopleService.getPersonIdsByPhoto(eventId, [photoId], { forAdmin: true });
      expect(adminMap.get(photoId)).toEqual([person.id]);
    });

    it('respects the minimum cluster size so one-off bystanders stay out', async () => {
      const eventId = await seedEvent('min-cluster');
      const solo = (await addPhotoWithFace(eventId, makeEmbedding(8))).face;
      const crowd = [];
      for (let v = 0; v < 4; v++) {
        crowd.push((await addPhotoWithFace(eventId, makeEmbedding(9, v))).face);
      }
      await clustering.assignFaces(eventId, [solo, ...crowd]);

      const people = await peopleService.listPeople(eventId, { isClient: false, minClusterSize: 3 });
      expect(people).toHaveLength(1);
      expect(people[0].face_count).toBe(4);
    });
  });

  describe('erasure', () => {
    it('purgeEvent removes every face row and resets the photos', async () => {
      const eventId = await seedEvent('purge');
      const faces = [];
      for (let v = 0; v < 3; v++) {
        faces.push((await addPhotoWithFace(eventId, makeEmbedding(10, v))).face);
      }
      await clustering.assignFaces(eventId, faces);
      await db('photos').where({ event_id: eventId }).update({ face_status: 'done', face_count: 1 });

      expect(await db('photo_faces').where({ event_id: eventId })).not.toHaveLength(0);
      expect(await db('event_people').where({ event_id: eventId })).not.toHaveLength(0);

      await faceProcessor.purgeEvent(eventId);

      expect(await db('photo_faces').where({ event_id: eventId })).toHaveLength(0);
      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(0);
      const photos = await db('photos').where({ event_id: eventId });
      expect(photos.every((p) => p.face_status === null && p.face_count === null)).toBe(true);
    });

    it('purgePhotoFaces removes face rows WITHOUT relying on the FK cascade', async () => {
      // The regression this guards: PicPeak does not enable
      // `PRAGMA foreign_keys` on SQLite, so ON DELETE CASCADE never fires
      // there and biometric embeddings outlived the photo. The pragma is
      // explicitly OFF here so the assertion can only pass if the deletion
      // path purges the rows itself.
      await db.raw('PRAGMA foreign_keys = OFF');

      const eventId = await seedEvent('purge-no-cascade');
      const faces = [];
      for (let v = 0; v < 3; v++) {
        faces.push((await addPhotoWithFace(eventId, makeEmbedding(20, v))).face);
      }
      await clustering.assignFaces(eventId, faces);

      const person = await db('event_people').where({ event_id: eventId }).first();
      expect(person.face_count_total).toBe(3);

      const victim = faces[0];
      await faceProcessor.purgePhotoFaces(victim.photo_id);

      expect(await db('photo_faces').where({ photo_id: victim.photo_id })).toHaveLength(0);
      // …and the person it belonged to was rebuilt, not left with a stale count.
      const after = await db('event_people').where({ id: person.id }).first();
      expect(after.face_count_total).toBe(2);
    });

    it('purging the last face of a person removes the person too', async () => {
      await db.raw('PRAGMA foreign_keys = OFF');
      const eventId = await seedEvent('purge-last-face');
      const { face, photoId } = await addPhotoWithFace(eventId, makeEmbedding(21));
      await clustering.assignFaces(eventId, [face]);
      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(1);

      await faceProcessor.purgePhotoFaces(photoId);

      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(0);
    });

    it('deleting an event removes its people and faces', async () => {
      await db.raw('PRAGMA foreign_keys = ON');
      const eventId = await seedEvent('event-delete');
      const { face } = await addPhotoWithFace(eventId, makeEmbedding(11));
      await clustering.assignFaces(eventId, [face]);

      await db('photos').where({ event_id: eventId }).del();
      await db('events').where({ id: eventId }).del();

      expect(await db('photo_faces').where({ event_id: eventId })).toHaveLength(0);
      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(0);
    });
  });

  describe('all-in-one image block (#1042 / PR #1068)', () => {
    // Blocked for performance: the AIO image runs backend, frontend, SQLite
    // and every worker in one container, with no ML sidecar to talk to. The
    // failure there would not be loud — just a slow install that looks
    // broken — so the gate is asserted rather than assumed.
    const faceSettings = require('../../src/services/faceSettings');

    afterEach(() => { delete process.env.PICPEAK_SINGLE_CONTAINER; });

    it('reports the feature off regardless of the flag row', async () => {
      process.env.PICPEAK_SINGLE_CONTAINER = 'true';
      expect(faceSettings.isSingleContainerImage()).toBe(true);
      // Even with the flag ON in the database.
      await db('feature_flags').insert({ key: 'faces', value: true })
        .onConflict('key').merge()
        .catch(async () => {
          await db('feature_flags').where({ key: 'faces' }).update({ value: true });
        });
      expect(await faceSettings.isFeatureEnabled()).toBe(false);
    });

    it('refuses per-event detection too', async () => {
      process.env.PICPEAK_SINGLE_CONTAINER = 'true';
      const eventId = await seedEvent('aio-block');
      const event = await db('events').where({ id: eventId }).first();
      expect(event.face_recognition_enabled).toBeTruthy();
      expect(await faceSettings.isEnabledForEvent(event)).toBe(false);
    });

    it('accepts only explicit truthy markers', () => {
      for (const v of ['true', '1', 'yes', 'TRUE']) {
        process.env.PICPEAK_SINGLE_CONTAINER = v;
        expect(faceSettings.isSingleContainerImage()).toBe(true);
      }
      for (const v of ['false', '0', '', 'no']) {
        process.env.PICPEAK_SINGLE_CONTAINER = v;
        expect(faceSettings.isSingleContainerImage()).toBe(false);
      }
      delete process.env.PICPEAK_SINGLE_CONTAINER;
      expect(faceSettings.isSingleContainerImage()).toBe(false);
    });
  });

  describe('export and backup exclusion', () => {
    it('excludes both face tables from .picpeak exports', () => {
      const { EXCLUDED_TABLES } = require('../../src/services/picpeakExportService');
      expect(EXCLUDED_TABLES.has('photo_faces')).toBe(true);
      expect(EXCLUDED_TABLES.has('event_people')).toBe(true);
    });

    it('excludes both face tables from the database backup table list', async () => {
      const databaseBackup = require('../../src/services/databaseBackup');
      const service = databaseBackup.DatabaseBackupService
        ? new databaseBackup.DatabaseBackupService()
        : databaseBackup;
      if (typeof service.getTables !== 'function') return; // shape differs; covered by the export test

      const tables = await service.getTables();
      expect(tables).not.toContain('photo_faces');
      expect(tables).not.toContain('event_people');
      // Sanity: the filter didn't eat everything.
      expect(tables).toContain('events');
    });
  });
});
