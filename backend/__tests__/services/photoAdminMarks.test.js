/**
 * The photographer's own stars and colour labels (#1044 follow-up).
 *
 * The property that matters most here is isolation: admin marks live in their
 * own table precisely so they can never reach a guest-facing surface. Pinned:
 *
 *  - rating and colour are independent halves of one mark — writing one must
 *    not wipe the other
 *  - a mark with neither half left is deleted, not kept as an empty row
 *  - two admins on the same event keep separate marks
 *  - marks never touch photo_feedback or the denormalized photos.* counters
 *    the gallery reads
 *  - invalid values are rejected the same way guest colour labels are
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-marks-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-marks-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const marks = require('../../src/services/photoAdminMarksService');
const feedbackService = require('../../src/services/feedbackService');

const ADMIN_A = 11;
const ADMIN_B = 22;

let db;
let cleanup;
let eventId;
let photoIds;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: 'admin-marks-test-event',
    event_type: 'wedding',
    event_name: 'Admin Marks Test',
    event_date: '2026-07-20',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: '/gallery/admin-marks-test-event/share',
    share_token: 'admin-marks-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];

  photoIds = [];
  for (let i = 0; i < 3; i++) {
    const photo = await db('photos').insert({
      event_id: eventId,
      filename: `photo-${i}.jpg`,
      path: `events/admin-marks/${i}.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoIds.push(photo[0]?.id ?? photo[0]);
  }
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('photoAdminMarksService (#1044 follow-up)', () => {
  it('sets a colour without touching the rating, and vice versa', async () => {
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { colorLabel: 'green' }))
      .toEqual({ rating: null, color_label: 'green' });

    // Writing the rating must leave the colour alone — the two lightbox key
    // groups write independently.
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { rating: 4 }))
      .toEqual({ rating: 4, color_label: 'green' });

    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { colorLabel: 'red' }))
      .toEqual({ rating: 4, color_label: 'red' });
  });

  it('keeps exactly one row per photo per admin', async () => {
    const rows = await db('photo_admin_marks')
      .where({ photo_id: photoIds[0], admin_id: ADMIN_A });
    expect(rows).toHaveLength(1);
  });

  it('clears one half with null and leaves the other', async () => {
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { colorLabel: null }))
      .toEqual({ rating: 4, color_label: null });
  });

  it('deletes the row once neither half is left', async () => {
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { rating: null })).toBeNull();
    const rows = await db('photo_admin_marks')
      .where({ photo_id: photoIds[0], admin_id: ADMIN_A });
    expect(rows).toHaveLength(0);
  });

  it('keeps two admins on the same photo independent', async () => {
    await marks.setMark(eventId, photoIds[1], ADMIN_A, { colorLabel: 'green' });
    await marks.setMark(eventId, photoIds[1], ADMIN_B, { colorLabel: 'red', rating: 2 });

    expect((await marks.getEventMarks(eventId, ADMIN_A))[photoIds[1]])
      .toEqual({ rating: null, color_label: 'green' });
    expect((await marks.getEventMarks(eventId, ADMIN_B))[photoIds[1]])
      .toEqual({ rating: 2, color_label: 'red' });
  });

  it('rejects colours outside the set and ratings outside 1-5', async () => {
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { colorLabel: 'chartreuse' }))
      .rejects.toThrow('Invalid color label');
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { rating: 6 }))
      .rejects.toThrow('Rating must be between 1 and 5');
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { rating: 0 }))
      .rejects.toThrow('Rating must be between 1 and 5');
    // Nothing was written by any of the rejected calls.
    expect(await marks.getEventMarks(eventId, ADMIN_A, [photoIds[2]])).toEqual({});
  });

  it('tags caller mistakes with a code, not just a message', async () => {
    // The route maps this to a 400. Keyed on the code so rewording the
    // message can't silently turn a bad request into a 500.
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { rating: 9 }))
      .rejects.toMatchObject({ code: marks.INVALID_MARK });
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { colorLabel: 'beige' }))
      .rejects.toMatchObject({ code: marks.INVALID_MARK });
  });

  it('narrows to a page of photo ids', async () => {
    expect(Object.keys(await marks.getEventMarks(eventId, ADMIN_A, [photoIds[1]])))
      .toEqual([String(photoIds[1])]);
    expect(await marks.getEventMarks(eventId, ADMIN_A, [])).toEqual({});
  });

  it('converges instead of 500ing when two marks race into the same row', async () => {
    // Simulate the check-then-insert race a keyboard triage pass produces:
    // both calls read "no row", one inserts, the other hits the unique index.
    // The loser must land on the winner's row, not throw — and the half it
    // did not address must keep the winner's value, not the stale pre-read.
    const photoId = photoIds[2];
    await db('photo_admin_marks').where({ photo_id: photoId }).delete();

    const [first, second] = await Promise.all([
      marks.setMark(eventId, photoId, ADMIN_A, { rating: 4 }),
      marks.setMark(eventId, photoId, ADMIN_A, { colorLabel: 'green' }),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const rows = await db('photo_admin_marks').where({ photo_id: photoId, admin_id: ADMIN_A });
    expect(rows).toHaveLength(1);
    // Whichever order they landed in, neither half may be lost.
    expect(rows[0].rating).toBe(4);
    expect(rows[0].color_label).toBe('green');

    await db('photo_admin_marks').where({ photo_id: photoId }).delete();
  });

  it('does not lose a concurrent half when the row already exists', async () => {
    // luap's finding on #1137: the insert race was handled, but two keystrokes
    // on a photo that ALREADY has a mark took a plain read-modify-write —
    // both calls read the old row, both wrote the full pair, and the second
    // clobbered the first with its stale value. That is the COMMON case in a
    // triage pass, since by the second keystroke there usually is a row.
    const photoId = photoIds[2];
    await db('photo_admin_marks').where({ photo_id: photoId }).delete();
    await marks.setMark(eventId, photoId, ADMIN_A, { rating: 3 });

    await Promise.all([
      marks.setMark(eventId, photoId, ADMIN_A, { rating: 4 }),
      marks.setMark(eventId, photoId, ADMIN_A, { colorLabel: 'blue' }),
    ]);

    const row = await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: ADMIN_A }).first();
    expect(row.rating).toBe(4);          // was 3 before the fix — the colour
    expect(row.color_label).toBe('blue'); // write reverted it

    await db('photo_admin_marks').where({ photo_id: photoId }).delete();
  });

  it('leaves the untouched half alone even when the caller sends only one', async () => {
    // The mechanism behind the fix: an unaddressed column is never written,
    // so it cannot be written with a stale value.
    const photoId = photoIds[2];
    await db('photo_admin_marks').where({ photo_id: photoId }).delete();
    await marks.setMark(eventId, photoId, ADMIN_A, { rating: 2, colorLabel: 'purple' });

    const before = await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: ADMIN_A }).first();

    await marks.setMark(eventId, photoId, ADMIN_A, { colorLabel: 'green' });
    const after = await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: ADMIN_A }).first();

    expect(after.rating).toBe(before.rating);
    expect(after.color_label).toBe('green');

    await db('photo_admin_marks').where({ photo_id: photoId }).delete();
  });

  it('counts colours per admin for the filter chips', async () => {
    await marks.setMark(eventId, photoIds[2], ADMIN_A, { colorLabel: 'green' });
    expect(await marks.getEventMarkColorCounts(eventId, ADMIN_A)).toEqual({ green: 2 });
    expect(await marks.getEventMarkColorCounts(eventId, ADMIN_B)).toEqual({ red: 1 });
    // A rating-only mark contributes no colour count.
    await marks.setMark(eventId, photoIds[0], ADMIN_A, { rating: 5 });
    expect(await marks.getEventMarkColorCounts(eventId, ADMIN_A)).toEqual({ green: 2 });
  });

  it('never leaks into guest feedback or the denormalized gallery counters', async () => {
    // Everything above wrote marks on all three photos.
    expect(await db('photo_feedback').count('* as count').first())
      .toEqual(expect.objectContaining({ count: 0 }));

    for (const photoId of photoIds) {
      // updatePhotoFeedbackStats is what the gallery payload reads; it must
      // still see an untouched photo.
      await feedbackService.updatePhotoFeedbackStats(photoId);
      const photo = await db('photos').where('id', photoId).first();
      expect(Number(photo.color_label_count) || 0).toBe(0);
      expect(Number(photo.average_rating) || 0).toBe(0);
      expect(Number(photo.feedback_count) || 0).toBe(0);
    }

    // And the guest-facing tallies stay empty.
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[1])).toEqual({});
    expect(await feedbackService.getEventColorLabelCounts(eventId)).toEqual({});
  });
});
