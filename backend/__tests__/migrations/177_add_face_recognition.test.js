/**
 * Migration 177 (#1074) — face recognition schema.
 *
 * The acceptance criteria for #1074 name three properties explicitly, so
 * they get tests rather than a manual check:
 *
 *   - idempotent on re-run,
 *   - a working down(),
 *   - and — the one that matters most — installing it must NOT enqueue
 *     anything. A `face_status` column defaulting to 'pending' would put
 *     every existing photo on every install into a queue the operator never
 *     asked for, on installs with no sidecar at all.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig177-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mig177-test-secret';

const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/177_add_face_recognition');

describe('migration 177 — face recognition schema', () => {
  let db; let cleanup;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('creates both tables with the columns the pipeline writes', async () => {
    expect(await db.schema.hasTable('photo_faces')).toBe(true);
    expect(await db.schema.hasTable('event_people')).toBe(true);

    for (const col of [
      'photo_id', 'event_id', 'bbox_x', 'bbox_y', 'bbox_w', 'bbox_h',
      'det_score', 'yaw', 'pitch', 'blur', 'embedding', 'model_version',
      'person_id', 'created_at',
    ]) {
      expect(await db.schema.hasColumn('photo_faces', col)).toBe(true);
    }

    for (const col of [
      'event_id', 'label', 'cover_face_id', 'centroid', 'face_count_total',
      'model_version', 'is_hidden', 'is_ignored',
    ]) {
      expect(await db.schema.hasColumn('event_people', col)).toBe(true);
    }
  });

  it('adds the photos and events columns', async () => {
    for (const col of ['face_status', 'face_count', 'face_started_at', 'face_error']) {
      expect(await db.schema.hasColumn('photos', col)).toBe(true);
    }
    for (const col of [
      'face_recognition_enabled', 'faces_visible_to_guests', 'faces_last_scan_at',
    ]) {
      expect(await db.schema.hasColumn('events', col)).toBe(true);
    }
  });

  it('enqueues nothing — face_status has no default', async () => {
    // The whole "zero behaviour change by default" guarantee rests on this.
    const [{ id: eventId }] = await db('events').insert({
      slug: 'mig177-event',
      event_type: 'wedding',
      event_name: 'Migration 177',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: 'mig177-share',
      expires_at: new Date().toISOString(),
    }).returning('id');

    const eid = typeof eventId === 'object' ? eventId.id : eventId;
    await db('photos').insert({
      event_id: eid, filename: 'a.jpg', path: '/tmp/a.jpg', type: 'individual',
    });

    const row = await db('photos').where({ event_id: eid }).first();
    expect(row.face_status).toBeNull();
    expect(await db('photo_faces').count({ c: '*' }).first()).toMatchObject({ c: 0 });
  });

  it('seeds the tunable thresholds rather than hardcoding them', async () => {
    // Immich's clustering guide exists because no single threshold survives
    // contact with every library — these must be operator-reachable.
    const keys = [
      'face_match_threshold', 'face_min_cluster_size',
      'face_quality_min_score', 'face_quality_min_px',
    ];
    const rows = await db('app_settings').whereIn('setting_key', keys);
    expect(rows).toHaveLength(keys.length);
    expect(rows.every((r) => r.setting_type === 'faces')).toBe(true);
  });

  it('is idempotent on re-run', async () => {
    await expect(migration.up(db)).resolves.not.toThrow();
    // And did not duplicate the settings rows.
    const rows = await db('app_settings').where('setting_key', 'face_match_threshold');
    expect(rows).toHaveLength(1);
  });

  it('down() removes everything it added, and up() restores it', async () => {
    await migration.down(db);

    expect(await db.schema.hasTable('photo_faces')).toBe(false);
    expect(await db.schema.hasTable('event_people')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'face_status')).toBe(false);
    expect(await db.schema.hasColumn('events', 'face_recognition_enabled')).toBe(false);
    expect(await db('app_settings').where('setting_key', 'face_match_threshold')).toHaveLength(0);

    await migration.up(db);
    expect(await db.schema.hasTable('photo_faces')).toBe(true);
    expect(await db.schema.hasColumn('photos', 'face_status')).toBe(true);
  });

  it('cascades face rows when a photo is deleted', async () => {
    // #1074 acceptance criterion: deleting a photo removes its face rows.
    //
    // SQLite ignores foreign keys unless the pragma is on, and PicPeak does
    // NOT enable it globally (a large amount of existing data and fixtures
    // would start failing). So the cascade below proves only that the schema
    // declares it correctly — the code does not RELY on it. Deletion paths
    // purge face rows explicitly; see faceProcessor.purgeEvent /
    // purgePhotoFaces and the erasure tests in facePrivacy.test.js.
    await db.raw('PRAGMA foreign_keys = ON');

    const [{ id: eventId }] = await db('events').insert({
      slug: 'mig177-cascade',
      event_type: 'wedding',
      event_name: 'Cascade',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: 'mig177-cascade-share',
      expires_at: new Date().toISOString(),
    }).returning('id');
    const eid = typeof eventId === 'object' ? eventId.id : eventId;

    const [{ id: photoId }] = await db('photos')
      .insert({ event_id: eid, filename: 'c.jpg', path: '/tmp/c.jpg', type: 'individual' })
      .returning('id');
    const pid = typeof photoId === 'object' ? photoId.id : photoId;

    await db('photo_faces').insert({
      photo_id: pid,
      event_id: eid,
      bbox_x: 1, bbox_y: 2, bbox_w: 3, bbox_h: 4,
      model_version: 'test',
      created_at: new Date().toISOString(),
    });
    expect(await db('photo_faces').where({ photo_id: pid })).toHaveLength(1);

    await db('photos').where({ id: pid }).del();
    expect(await db('photo_faces').where({ photo_id: pid })).toHaveLength(0);
  });
});
