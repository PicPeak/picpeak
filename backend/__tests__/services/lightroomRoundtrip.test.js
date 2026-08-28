/**
 * Lightroom round-trip (#745) — pins the pieces that let a client's proofing
 * verdict reach a desktop catalogue and a finished edit come back:
 *
 *  - migration 193 adds photos.source_filename and backfills it, so galleries
 *    that predate the round-trip can still match on their first pass
 *  - source_filename survives replacePhoto(); original_filename does not.
 *    This is the whole point of the column: without it, the first re-upload
 *    of a renamed render destroys the key the NEXT round-trip needs
 *  - the number_token match mode reads the LONGEST trailing digit run, which
 *    is what makes the multi-camera cam1/cam2 prefix scheme work
 *  - ambiguity is refused, never guessed
 *  - mergeMarks collapses three possible opinions into the one colour and one
 *    rating Lightroom has room for
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-lr-roundtrip-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lr-roundtrip-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { mergeMarks, roundRating } = require('../../src/services/markMerge');

let db;
let cleanup;
let eventId;
let adminId;

async function addPhoto({ filename, originalFilename, sourceFilename }) {
  const [row] = await db('photos').insert({
    event_id: eventId,
    filename,
    original_filename: originalFilename,
    source_filename: sourceFilename,
    path: `slug/${filename}`,
    type: 'individual',
  }).returning('id');
  return row?.id || row;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));

  const [event] = await db('events').insert({
    slug: 'lr-roundtrip-event',
    event_name: 'Round-trip Event',
    event_type: 'wedding',
    event_date: '2026-08-25',
    host_email: 'host@example.com',
    password_hash: 'not-a-real-hash',
    admin_email: 'admin@example.com',
    share_link: 'lr-roundtrip-event',
    expires_at: '2027-08-25',
  }).returning('id');
  eventId = event?.id || event;
});

afterAll(async () => { await cleanup(); });

describe('migration 193 — photos.source_filename', () => {
  it('adds the column', async () => {
    expect(await db.schema.hasColumn('photos', 'source_filename')).toBe(true);
  });

  it('backfills existing rows from original_filename', async () => {
    // Simulate a row that predates the migration: column nulled out, then the
    // migration's backfill re-run against it.
    const id = await addPhoto({
      filename: 'legacy.jpg', originalFilename: 'IMG_9001.JPG', sourceFilename: null,
    });
    const migration = require('../../migrations/core/193_add_photo_source_filename.js');
    await migration.up(db);

    const row = await db('photos').where({ id }).first();
    expect(row.source_filename).toBe('IMG_9001.JPG');
  });
});

describe('findReplacementCandidate', () => {
  const { findReplacementCandidate, trailingDigitRun } =
    require('../../src/services/photoReplacementService');

  it('extracts the longest trailing digit run, not a fixed slice', () => {
    expect(trailingDigitRun('IMG_1234.JPG')).toBe('1234');
    expect(trailingDigitRun('Smith_Wedding_11234.jpg')).toBe('11234');
    expect(trailingDigitRun('DSC_0042.NEF')).toBe('0042');
    expect(trailingDigitRun('no-digits.jpg')).toBeNull();
    expect(trailingDigitRun(null)).toBeNull();
  });

  it('keeps the two bodies of a multi-camera shoot apart', () => {
    // The whole reason the camera index is prefixed INTO the number: a
    // last-4 slice would read 1234 from both and collide.
    expect(trailingDigitRun('cam11234.jpg')).toBe('11234');
    expect(trailingDigitRun('cam21234.jpg')).toBe('21234');
  });

  it('matches exactly, case-insensitively, in exact mode', async () => {
    await addPhoto({
      filename: 'stored_a.jpg', originalFilename: 'IMG_2001.JPG', sourceFilename: 'IMG_2001.JPG',
    });
    const hit = await findReplacementCandidate(eventId, 'img_2001.jpg');
    expect(hit).toBeTruthy();
    expect(hit.original_filename).toBe('IMG_2001.JPG');
  });

  it('does NOT match a renamed render in exact mode', async () => {
    expect(await findReplacementCandidate(eventId, 'Smith_Wedding_2001.jpg')).toBeNull();
  });

  it('matches a renamed render in number_token mode', async () => {
    const hit = await findReplacementCandidate(
      eventId, 'Smith_Wedding_2001.jpg', { matchMode: 'number_token' },
    );
    expect(hit).toBeTruthy();
    expect(hit.original_filename).toBe('IMG_2001.JPG');
  });

  it('refuses rather than guessing when two photos share a number', async () => {
    await addPhoto({
      filename: 'stored_b.jpg', originalFilename: 'DSC_2001.NEF', sourceFilename: 'DSC_2001.NEF',
    });
    const result = await findReplacementCandidate(
      eventId, 'Anything_2001.jpg', { matchMode: 'number_token' },
    );
    expect(result).toEqual({ ambiguous: true, count: 2 });
  });

  it('returns null in number_token mode when the name has no digits', async () => {
    expect(await findReplacementCandidate(
      eventId, 'untitled.jpg', { matchMode: 'number_token' },
    )).toBeNull();
  });
});

describe('replacePhoto — review blockers on #1165', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { replacePhoto } = require('../../src/services/photoReplacementService');

  const makeTempFile = () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-replace-')), 'render.jpg');
    // A 1x1 JPEG is enough: sharp may fail on it, and replacePhoto is
    // required to survive that (thumbnail generation is best-effort).
    fs.writeFileSync(p, Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
      + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
      + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'));
    return p;
  };

  it('repoints an external row to managed, so viewers stop getting the old file', async () => {
    // resolvePhotoStorageKey gives photo.source_origin precedence and returns
    // null for 'external' — so a replacement that left it set would upload the
    // edit, report success, and keep serving the untouched NAS original.
    const id = await addPhoto({
      filename: 'ext.jpg', originalFilename: 'IMG_7001.JPG', sourceFilename: 'IMG_7001.JPG',
    });
    await db('photos').where({ id }).update({
      source_origin: 'external', external_relpath: 'nas/sub/IMG_7001.JPG',
    });

    const existing = await db('photos').where({ id }).first();
    const event = await db('events').where({ id: eventId }).first();
    const result = await replacePhoto(existing, makeTempFile(), {
      originalFilename: 'Edited_7001.jpg', mimeType: 'image/jpeg', event,
    });

    expect(result.success).toBe(true);
    const row = await db('photos').where({ id }).first();
    expect(row.source_origin).toBe('managed');
    expect(row.external_relpath).toBeNull();
  });

  it('deletes the temp file it was handed', async () => {
    // putFromFile copies rather than moves, and the v1 route disables its own
    // cleanup — so leaving this behind stranded up to 100 MB per replacement.
    const id = await addPhoto({
      filename: 'leak.jpg', originalFilename: 'IMG_7002.JPG', sourceFilename: 'IMG_7002.JPG',
    });
    const existing = await db('photos').where({ id }).first();
    const event = await db('events').where({ id: eventId }).first();
    const tempPath = makeTempFile();

    const result = await replacePhoto(existing, tempPath, {
      originalFilename: 'Edited_7002.jpg', mimeType: 'image/jpeg', event,
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});

describe('migration 193 backfill reaches watcher and external rows', () => {
  it('falls back to filename when original_filename was never set', async () => {
    // fileWatcher and adminExternalMedia insert `filename` only. Copying
    // original_filename alone left those galleries with a NULL match key.
    const [row] = await db('photos').insert({
      event_id: eventId, filename: 'IMG_8001.JPG', original_filename: null,
      source_filename: null, path: 'slug/IMG_8001.JPG', type: 'individual',
    }).returning('id');
    const id = row?.id || row;

    const migration = require('../../migrations/core/193_add_photo_source_filename.js');
    await migration.up(db);

    const after = await db('photos').where({ id }).first();
    expect(after.source_filename).toBe('IMG_8001.JPG');
  });
});

describe('mergeMarks', () => {
  const photo = {
    dominant_color_label: 'green',
    average_rating: 4.6,
    my_color_label: 'red',
    my_rating: 2,
  };

  it('reads only the client verdict for mark_source=client', () => {
    expect(mergeMarks(photo, 'client')).toEqual({ color_label: 'green', rating: 5 });
  });

  it('reads only the photographer verdict for mark_source=mine', () => {
    expect(mergeMarks(photo, 'mine')).toEqual({ color_label: 'red', rating: 2 });
  });

  it('lets the photographer win the colour but keeps the higher rating', () => {
    // Colour is a category — one deliberate choice beats an aggregate a
    // tie-break already had to guess at. Rating is a magnitude, so taking the
    // max avoids quietly demoting a photo somebody rated highly.
    expect(mergeMarks(photo, 'either')).toEqual({ color_label: 'red', rating: 5 });
  });

  it('falls back to the client colour when the photographer set none', () => {
    expect(mergeMarks({ ...photo, my_color_label: null }, 'either').color_label).toBe('green');
  });

  it('reports no marks as null rather than 0/empty string', () => {
    expect(mergeMarks({}, 'either')).toEqual({ color_label: null, rating: null });
    expect(mergeMarks(null, 'either')).toEqual({ color_label: null, rating: null });
  });

  it('keeps "somebody rated this" distinguishable from "nobody did"', () => {
    // Matches XmpGenerator.mapRating: any non-zero average is at least 1 star.
    expect(roundRating(0)).toBe(0);
    expect(roundRating(0.4)).toBe(1);
    expect(roundRating(4.5)).toBe(5);
  });
});

describe('PhotoFilterBuilder — marked_only', () => {
  const { PhotoFilterBuilder } = require('../../src/utils/photoFilterBuilder');

  const build = (filters) => {
    const b = new PhotoFilterBuilder(db('photos').select('photos.id'), eventId);
    return b.applyFilters(filters).getQuery();
  };

  it('matches nothing when mark_source=mine has no admin_id', async () => {
    // Must not silently widen to the whole event.
    const rows = await build({ marked_only: true, mark_source: 'mine' });
    expect(rows).toHaveLength(0);
  });

  it('finds photos carrying the photographer own mark', async () => {
    const id = await addPhoto({
      filename: 'marked.jpg', originalFilename: 'IMG_3001.JPG', sourceFilename: 'IMG_3001.JPG',
    });
    await db('photo_admin_marks').insert({
      photo_id: id, event_id: eventId, admin_id: adminId, color_label: 'green',
    });

    const rows = await build({ marked_only: true, mark_source: 'mine', admin_id: adminId });
    expect(rows.map(r => r.id)).toContain(id);
  });

  it('ignores another admin marks', async () => {
    const rows = await build({
      marked_only: true, mark_source: 'mine', admin_id: adminId + 999,
    });
    expect(rows).toHaveLength(0);
  });
});
