/**
 * Colour labels (#1044) — pins the contract of the `color_label` feedback
 * type, which shares its single-value machinery with emoji reactions (#839):
 *  - only the five Lightroom colours are accepted
 *  - one label per guest per photo: the same colour again toggles OFF,
 *    a different colour SWITCHES the existing row (never a second row)
 *  - per-guest scoping mirrors reactions: guest_id when present, else the
 *    device-hash guest_identifier
 *  - a check-then-insert race that produced duplicate rows collapses on the
 *    next interaction instead of leaving a phantom count
 *  - denormalized photos.color_label_count and the per-colour tallies follow
 *    visibility: hidden-by-moderator labels disappear from both
 *  - the exports carry the colour
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-feedback-color-labels-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'feedback-color-labels-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const feedbackService = require('../../src/services/feedbackService');
const { COLOR_LABELS, dominantColorLabel } = require('../../src/constants/colorLabels');
const { XmpGenerator } = require('../../src/services/xmpGenerator');

const EVENT_SLUG = 'color-labels-test-event';
const GUEST_A = 'guest-a-identifier';
const GUEST_B = 'guest-b-identifier';

let db;
let cleanup;
let eventId;
let photoIds;

async function label(photoId, color, { guestIdentifier = GUEST_A, guestId = null } = {}) {
  return feedbackService.submitFeedback(photoId, eventId, {
    feedback_type: 'color_label',
    color_label: color,
    guest_id: guestId,
    ip_address: '127.0.0.1',
    user_agent: 'jest',
  }, guestIdentifier);
}

async function colorLabelCountOf(photoId) {
  const row = await db('photos').where('id', photoId).first();
  return Number(row.color_label_count) || 0;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: EVENT_SLUG,
    event_type: 'wedding',
    event_name: 'Colour Labels Test',
    event_date: '2026-07-20',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${EVENT_SLUG}/share`,
    share_token: 'color-labels-test-share',
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
      path: `events/color-labels/${i}.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoIds.push(photo[0]?.id ?? photo[0]);
  }
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('colour label submission (#1044)', () => {
  it('rejects colours outside the Lightroom set', async () => {
    await expect(label(photoIds[0], 'chartreuse')).rejects.toThrow('Invalid color label');
    await expect(label(photoIds[0], 'Green')).rejects.toThrow('Invalid color label'); // case matters
    await expect(label(photoIds[0], undefined)).rejects.toThrow('Invalid color label');
    expect(await colorLabelCountOf(photoIds[0])).toBe(0);
  });

  it('creates a label row and maintains the denormalized count', async () => {
    const result = await label(photoIds[0], 'green');
    expect(result.created).toBe(true);

    const row = await db('photo_feedback')
      .where({ photo_id: photoIds[0], feedback_type: 'color_label' })
      .first();
    expect(row.color_label).toBe('green');
    expect(await colorLabelCountOf(photoIds[0])).toBe(1);
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[0])).toEqual({ green: 1 });
  });

  it('switches to another colour in place — never a second row per guest', async () => {
    const result = await label(photoIds[0], 'red');
    expect(result.updated).toBe(true);

    const rows = await db('photo_feedback')
      .where({ photo_id: photoIds[0], feedback_type: 'color_label' });
    expect(rows).toHaveLength(1);
    expect(rows[0].color_label).toBe('red');
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[0])).toEqual({ red: 1 });
  });

  it('tallies different guests per colour', async () => {
    await label(photoIds[0], 'red', { guestIdentifier: GUEST_B });
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[0])).toEqual({ red: 2 });
    expect(await colorLabelCountOf(photoIds[0])).toBe(2);
  });

  it('toggles off with the same colour', async () => {
    const result = await label(photoIds[0], 'red');
    expect(result.removed).toBe(true);
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[0])).toEqual({ red: 1 }); // GUEST_B remains
    expect(await colorLabelCountOf(photoIds[0])).toBe(1);
  });

  it('scopes per guest_id when present — two token-guests on one device stay independent', async () => {
    const first = await label(photoIds[1], 'green', { guestIdentifier: GUEST_A, guestId: 101 });
    const second = await label(photoIds[1], 'blue', { guestIdentifier: GUEST_A, guestId: 102 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true); // NOT treated as guest 101's switch
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[1]))
      .toEqual({ green: 1, blue: 1 });
  });

  it('accepts every colour of the set', async () => {
    for (const color of COLOR_LABELS) {
      const res = await label(photoIds[2], color, { guestIdentifier: `guest-${color}` });
      expect(res.created).toBe(true);
    }
    const counts = await feedbackService.getPhotoColorLabelCounts(photoIds[2]);
    expect(Object.keys(counts).sort()).toEqual([...COLOR_LABELS].sort());
  });

  it('hidden labels leave both the per-colour tallies and color_label_count', async () => {
    const row = await db('photo_feedback')
      .where({ photo_id: photoIds[0], feedback_type: 'color_label' })
      .first();
    await feedbackService.moderateFeedback(row.id, 'hide', 1);

    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[0])).toEqual({});
    expect(await colorLabelCountOf(photoIds[0])).toBe(0);

    await feedbackService.moderateFeedback(row.id, 'approve', 1);
    expect(await colorLabelCountOf(photoIds[0])).toBe(1);
  });

  it('toggle and switch collapse racy duplicate rows for the same guest', async () => {
    // Simulate the check-then-insert race: two rows for one guest+photo.
    const mk = (color) => ({
      photo_id: photoIds[1], event_id: eventId, feedback_type: 'color_label',
      color_label: color, guest_identifier: 'dup-guest', is_approved: true, is_hidden: false,
      created_at: new Date(), updated_at: new Date(),
    });
    await db('photo_feedback').insert([mk('yellow'), mk('yellow')]);

    // Switching converges to exactly ONE row with the new colour…
    const switched = await label(photoIds[1], 'purple', { guestIdentifier: 'dup-guest' });
    expect(switched.updated).toBe(true);
    let rows = await db('photo_feedback')
      .where({ photo_id: photoIds[1], feedback_type: 'color_label', guest_identifier: 'dup-guest' });
    expect(rows).toHaveLength(1);
    expect(rows[0].color_label).toBe('purple');

    // …and toggle-off removes the full guest-scoped set.
    await db('photo_feedback').insert(mk('purple'));
    const removed = await label(photoIds[1], 'purple', { guestIdentifier: 'dup-guest' });
    expect(removed.removed).toBe(true);
    rows = await db('photo_feedback')
      .where({ photo_id: photoIds[1], feedback_type: 'color_label', guest_identifier: 'dup-guest' });
    expect(rows).toHaveLength(0);
  });

  it('reactions and colour labels coexist on the same photo and guest', async () => {
    await feedbackService.submitFeedback(photoIds[0], eventId, {
      feedback_type: 'reaction',
      reaction: '❤️',
      ip_address: '127.0.0.1',
      user_agent: 'jest',
    }, GUEST_B);
    await label(photoIds[0], 'blue', { guestIdentifier: GUEST_B });

    // Switching the colour must not disturb the reaction row, and vice versa.
    expect(await feedbackService.getPhotoReactionCounts(photoIds[0])).toEqual({ '❤️': 1 });
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[0])).toEqual({ blue: 1 });
  });

  it('event-wide colour counts group per photo', async () => {
    const byPhoto = await feedbackService.getEventColorLabelCounts(eventId);
    expect(byPhoto[photoIds[2]]).toEqual(
      COLOR_LABELS.reduce((acc, c) => ({ ...acc, [c]: 1 }), {}),
    );
    // Narrowing to a page of ids only returns those.
    const narrowed = await feedbackService.getEventColorLabelCounts(eventId, [photoIds[2]]);
    expect(Object.keys(narrowed)).toEqual([String(photoIds[2])]);
    expect(await feedbackService.getEventColorLabelCounts(eventId, [])).toEqual({});
  });

  it('summary and exports carry colour labels', async () => {
    const summary = await feedbackService.getEventFeedbackSummary(eventId);
    expect(Number(summary.stats.total_color_labels)).toBeGreaterThan(0);

    const longRows = await feedbackService.exportEventFeedback(eventId);
    const longLabel = longRows.find((r) => r.feedback_type === 'color_label');
    expect(COLOR_LABELS).toContain(longLabel.color_label);

    const pivotRows = await feedbackService.exportEventFeedbackPivoted(eventId);
    const pivotWithLabel = pivotRows.find((r) => r.color_label);
    expect(COLOR_LABELS).toContain(pivotWithLabel.color_label);
  });
});

describe('dominant colour + XMP round-trip (#1044)', () => {
  it('picks the most-labelled colour, breaking ties toward the 1st-choice order', () => {
    expect(dominantColorLabel({ red: 3, green: 1 })).toBe('red');
    // Tie: green is "1st choice" in the proofing workflow, so it survives.
    expect(dominantColorLabel({ red: 2, green: 2 })).toBe('green');
    expect(dominantColorLabel({})).toBeNull();
    expect(dominantColorLabel(null)).toBeNull();
  });

  it('xmp:Label prefers a real colour label over the rating-derived guess', () => {
    const generator = new XmpGenerator();
    // A 5-star photo would historically map to 'Red'. An explicit green label wins.
    expect(generator.mapLabel({ average_rating: 5, dominant_color_label: 'green' })).toBe('Green');
    expect(generator.mapLabel({ average_rating: 5, color_labels: { blue: 1 } })).toBe('Blue');
    // No label: unchanged legacy behaviour, so existing exports don't move.
    expect(generator.mapLabel({ average_rating: 5 })).toBe('Red');
    expect(generator.mapLabel({ average_rating: 0 })).toBeNull();
    // Tolerates the pre-#1044 call shape (a bare average rating).
    expect(generator.mapLabel(4.6)).toBe('Red');
  });

  it('writes the label into the sidecar and adds a searchable keyword', () => {
    const generator = new XmpGenerator();
    const xmp = generator.generateXmp({
      filename: 'a.jpg',
      average_rating: 0,
      like_count: 0,
      favorite_count: 0,
      dominant_color_label: 'yellow',
      color_labels: { yellow: 2 },
    });
    expect(xmp).toContain('xmp:Label="Yellow"');
    expect(xmp).toContain('color-yellow');
  });
});
