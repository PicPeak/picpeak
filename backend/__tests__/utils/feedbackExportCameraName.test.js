/**
 * Feedback exports carry the camera-original filename (#1224).
 *
 * Both exports used to select only `photos.filename` — the sanitized stored
 * name — so a photographer acting on client picks had nothing to match the
 * masters on disk with.
 *
 * The load-bearing case is the third one: `original_filename` is overwritten
 * the first time an edited render is uploaded over a proof (#745), so an
 * export that read it alone would name the render rather than the master and
 * silently stop matching. `source_filename` survives a replace by design
 * (migration 193) and must win.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-feedback-export-camera-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'feedback-export-camera-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const feedbackService = require('../../src/services/feedbackService');

const EVENT_SLUG = 'feedback-export-camera-event';
const GUEST = 'guest-camera-identifier';

let db;
let cleanup;
let eventId;

// filename is always the sanitized stored name; the other two vary per case.
async function addPhoto({ filename, originalFilename, sourceFilename }) {
  const inserted = await db('photos').insert({
    event_id: eventId,
    filename,
    original_filename: originalFilename,
    source_filename: sourceFilename,
    path: `events/camera-name/${filename}`,
    type: 'individual',
    uploaded_at: new Date().toISOString(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

async function like(photoId) {
  return feedbackService.submitFeedback(photoId, eventId, {
    feedback_type: 'like',
    guest_id: null,
    ip_address: '127.0.0.1',
    user_agent: 'jest',
  }, GUEST);
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: EVENT_SLUG,
    event_type: 'wedding',
    event_name: 'Feedback Export Camera Name',
    event_date: '2026-08-28',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${EVENT_SLUG}/share`,
    share_token: 'feedback-export-camera-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('feedback exports carry the camera-original filename (#1224)', () => {
  it('reports the camera name alongside the stored name, in both shapes', async () => {
    const photoId = await addPhoto({
      filename: 'wedding-smith_individual_1755892345.jpg',
      originalFilename: 'IMG_1234.JPG',
      sourceFilename: 'IMG_1234.JPG',
    });
    await like(photoId);

    const [longRow] = (await feedbackService.exportEventFeedback(eventId))
      .filter((r) => r.filename === 'wedding-smith_individual_1755892345.jpg');
    expect(longRow.original_filename).toBe('IMG_1234.JPG');
    // The stored name is still there — this adds a column, it does not swap one.
    expect(longRow.filename).toBe('wedding-smith_individual_1755892345.jpg');

    const [pivotRow] = (await feedbackService.exportEventFeedbackPivoted(eventId))
      .filter((r) => r.filename === 'wedding-smith_individual_1755892345.jpg');
    expect(pivotRow.original_filename).toBe('IMG_1234.JPG');
  });

  it('keeps naming the master after a replace overwrote original_filename', async () => {
    // Exactly the post-round-trip row: the edited render's name landed in
    // original_filename, source_filename still holds what the camera wrote.
    const photoId = await addPhoto({
      filename: 'wedding-smith_individual_1755892999.jpg',
      originalFilename: 'Smith_Wedding_1234.jpg',
      sourceFilename: 'IMG_1234.JPG',
    });
    await like(photoId);

    const [longRow] = (await feedbackService.exportEventFeedback(eventId))
      .filter((r) => r.filename === 'wedding-smith_individual_1755892999.jpg');
    expect(longRow.original_filename).toBe('IMG_1234.JPG');

    const [pivotRow] = (await feedbackService.exportEventFeedbackPivoted(eventId))
      .filter((r) => r.filename === 'wedding-smith_individual_1755892999.jpg');
    expect(pivotRow.original_filename).toBe('IMG_1234.JPG');
  });

  it('falls back to original_filename when nothing was captured at ingest', async () => {
    const photoId = await addPhoto({
      filename: 'wedding-smith_individual_1755893111.jpg',
      originalFilename: 'DSC_9001.NEF',
      sourceFilename: null,
    });
    await like(photoId);

    const [longRow] = (await feedbackService.exportEventFeedback(eventId))
      .filter((r) => r.filename === 'wedding-smith_individual_1755893111.jpg');
    expect(longRow.original_filename).toBe('DSC_9001.NEF');
  });

  it('leaves the column empty rather than repeating the sanitized name', async () => {
    // Blank reads as "no match possible". Echoing the stored name would invite
    // a match attempt against a file that does not exist under that name.
    const photoId = await addPhoto({
      filename: 'wedding-smith_individual_1755893222.jpg',
      originalFilename: null,
      sourceFilename: null,
    });
    await like(photoId);

    const [longRow] = (await feedbackService.exportEventFeedback(eventId))
      .filter((r) => r.filename === 'wedding-smith_individual_1755893222.jpg');
    expect(longRow.original_filename).toBeNull();

    const [pivotRow] = (await feedbackService.exportEventFeedbackPivoted(eventId))
      .filter((r) => r.filename === 'wedding-smith_individual_1755893222.jpg');
    // The pivot builds plain objects, so its empty is '' rather than null.
    expect(pivotRow.original_filename).toBe('');
  });
});
