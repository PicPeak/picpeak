/**
 * Auto-category rule engine (#1074 phase 3).
 *
 * The rules themselves are simple enough to read. What needs testing is the
 * promise around them: this engine may only ever fill an EMPTY category, and
 * everything it touches must be reversible. A photographer's own assignment
 * is a decision; this is a heuristic, and the heuristic never wins.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-autocat-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'autocat-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let engine;

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

/** A scanned photo with `faceCount` faces, each `faceSide` px square. */
async function addScannedPhoto(eventId, faceCount, { faceSide = 400, categoryId = null } = {}) {
  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: `${Math.random()}.jpg`,
    path: '/tmp/x.jpg',
    type: 'individual',
    width: 1000,
    height: 1000,
    processing_status: 'complete',
    face_status: 'done',
    face_count: faceCount,
    category_id: categoryId,
  }).returning('id');
  const photoId = typeof p === 'object' ? p.id : p;

  for (let i = 0; i < faceCount; i++) {
    await db('photo_faces').insert({
      photo_id: photoId,
      event_id: eventId,
      bbox_x: 10, bbox_y: 10, bbox_w: faceSide, bbox_h: faceSide,
      det_score: 0.95,
      model_version: 'test-v1',
      created_at: new Date().toISOString(),
    });
  }
  return photoId;
}

async function enable(on) {
  const existing = await db('app_settings')
    .where('setting_key', 'face_auto_categorize_enabled').first();
  if (existing) {
    await db('app_settings')
      .where('setting_key', 'face_auto_categorize_enabled')
      .update({ setting_value: JSON.stringify(on) });
  }
}

async function categoryOf(photoId) {
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo.category_id) return null;
  const cat = await db('photo_categories').where({ id: photo.category_id }).first();
  return cat?.slug ?? null;
}

describe('faceAutoCategories (#1074 phase 3)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    engine = require('../../src/services/faceAutoCategories');
    await enable(true);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('rules', () => {
    it('sorts by face count, and by face size for portraits', async () => {
      const eventId = await seedEvent('rules');
      // 400px face in a 1000x1000 frame = 16% of the frame, over the 8% floor.
      const portrait = await addScannedPhoto(eventId, 1, { faceSide: 400 });
      const details = await addScannedPhoto(eventId, 0);
      const small = await addScannedPhoto(eventId, 3);
      const group = await addScannedPhoto(eventId, 9);

      await engine.categorizeEvent(eventId);

      expect(await categoryOf(details)).toBe('details');
      expect(await categoryOf(portrait)).toBe('portraits');
      expect(await categoryOf(small)).toBe('small-groups');
      expect(await categoryOf(group)).toBe('groups');
    });

    it('does not call a distant single face a portrait', async () => {
      // One person in a wide landscape is not a portrait of them. 60px in a
      // 1000x1000 frame is 0.36% — far below the 8% floor.
      const eventId = await seedEvent('small-face');
      const distant = await addScannedPhoto(eventId, 1, { faceSide: 60 });

      await engine.categorizeEvent(eventId);

      expect(await categoryOf(distant)).toBeNull();
    });

    it('ignores photos that have not been scanned', async () => {
      const eventId = await seedEvent('unscanned');
      const [p] = await db('photos').insert({
        event_id: eventId, filename: 'u.jpg', path: '/tmp/u.jpg', type: 'individual',
        processing_status: 'complete', face_status: 'pending',
      }).returning('id');
      const photoId = typeof p === 'object' ? p.id : p;

      await engine.categorizeEvent(eventId);
      expect(await categoryOf(photoId)).toBeNull();
    });
  });

  describe('the promise', () => {
    it('NEVER overwrites a category a person chose', async () => {
      // The single most important behaviour in this file.
      const eventId = await seedEvent('no-overwrite');
      const [c] = await db('photo_categories').insert({
        name: 'Ceremony', slug: 'ceremony', is_global: false, event_id: eventId,
        created_at: new Date().toISOString(),
      }).returning('id');
      const ceremonyId = typeof c === 'object' ? c.id : c;

      // 9 faces — the rules would call this "groups" if they were allowed to.
      const claimed = await addScannedPhoto(eventId, 9, { categoryId: ceremonyId });

      await engine.categorizeEvent(eventId);

      expect(await categoryOf(claimed)).toBe('ceremony');
      const row = await db('photos').where({ id: claimed }).first();
      expect(row.auto_categorized).toBeFalsy();
    });

    it('marks only what it assigned, so undo is exact', async () => {
      const eventId = await seedEvent('undo');
      const [c] = await db('photo_categories').insert({
        name: 'Ceremony', slug: 'ceremony-2', is_global: false, event_id: eventId,
        created_at: new Date().toISOString(),
      }).returning('id');
      const ceremonyId = typeof c === 'object' ? c.id : c;

      const manual = await addScannedPhoto(eventId, 4, { categoryId: ceremonyId });
      const auto = await addScannedPhoto(eventId, 4);

      await engine.categorizeEvent(eventId);
      expect(await categoryOf(auto)).toBe('small-groups');

      const result = await engine.undoEvent(eventId);

      expect(result.cleared).toBe(1);
      // The automatic one is cleared...
      expect(await categoryOf(auto)).toBeNull();
      // ...and the photographer's own choice survives untouched.
      expect(await categoryOf(manual)).toBe('ceremony-2');
    });

    it('is a no-op while the setting is off', async () => {
      const eventId = await seedEvent('disabled');
      const photoId = await addScannedPhoto(eventId, 0);

      await enable(false);
      const result = await engine.categorizeEvent(eventId);
      await enable(true);

      expect(result.skipped).toBe(true);
      expect(await categoryOf(photoId)).toBeNull();
    });

    it('is idempotent — a second run assigns nothing new', async () => {
      const eventId = await seedEvent('idempotent');
      await addScannedPhoto(eventId, 0);
      await addScannedPhoto(eventId, 7);

      const first = await engine.categorizeEvent(eventId);
      const second = await engine.categorizeEvent(eventId);

      expect(first.assigned).toBe(2);
      expect(second.assigned).toBe(0);
    });

    it('reuses one category per slug rather than creating duplicates', async () => {
      const eventId = await seedEvent('reuse');
      await addScannedPhoto(eventId, 0);
      await addScannedPhoto(eventId, 0);
      await addScannedPhoto(eventId, 0);

      await engine.categorizeEvent(eventId);

      const details = await db('photo_categories')
        .where({ slug: 'details' })
        .where(function () { this.where('event_id', eventId).orWhere('is_global', true); });
      expect(details).toHaveLength(1);
    });
  });
});
