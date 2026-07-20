/**
 * Emoji reactions (#839) — pins the contract of the `reaction` feedback type:
 *  - only emojis from the fixed curated set are accepted
 *  - one reaction per guest per photo: same emoji again toggles OFF,
 *    a different emoji SWITCHES the existing row (never a second row)
 *  - per-guest scoping mirrors likes: guest_id when present, else the
 *    device-hash guest_identifier — two token-guests on one device react
 *    independently
 *  - denormalized photos.reaction_count and the per-emoji tallies follow
 *    visibility: hidden-by-moderator reactions disappear from both
 *  - the long and pivoted exports carry the reaction
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-feedback-reactions-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'feedback-reactions-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const feedbackService = require('../../src/services/feedbackService');
const { REACTION_EMOJIS } = require('../../src/constants/reactions');

const EVENT_SLUG = 'reactions-test-event';
const GUEST_A = 'guest-a-identifier';
const GUEST_B = 'guest-b-identifier';

let db;
let cleanup;
let eventId;
let photoIds;

async function react(photoId, emoji, { guestIdentifier = GUEST_A, guestId = null } = {}) {
  return feedbackService.submitFeedback(photoId, eventId, {
    feedback_type: 'reaction',
    reaction: emoji,
    guest_id: guestId,
    ip_address: '127.0.0.1',
    user_agent: 'jest',
  }, guestIdentifier);
}

async function reactionCountOf(photoId) {
  const row = await db('photos').where('id', photoId).first();
  return Number(row.reaction_count) || 0;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: EVENT_SLUG,
    event_type: 'wedding',
    event_name: 'Reactions Test',
    event_date: '2026-07-20',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${EVENT_SLUG}/share`,
    share_token: 'reactions-test-share',
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
      path: `events/reactions/${i}.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoIds.push(photo[0]?.id ?? photo[0]);
  }
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('reaction submission (#839)', () => {
  it('rejects emojis outside the curated set', async () => {
    await expect(react(photoIds[0], '🦄')).rejects.toThrow('Invalid reaction');
    await expect(react(photoIds[0], undefined)).rejects.toThrow('Invalid reaction');
    expect(await reactionCountOf(photoIds[0])).toBe(0);
  });

  it('creates a reaction row and maintains the denormalized count', async () => {
    const result = await react(photoIds[0], '❤️');
    expect(result.created).toBe(true);

    const row = await db('photo_feedback')
      .where({ photo_id: photoIds[0], feedback_type: 'reaction' })
      .first();
    expect(row.reaction).toBe('❤️');
    expect(await reactionCountOf(photoIds[0])).toBe(1);
    expect(await feedbackService.getPhotoReactionCounts(photoIds[0])).toEqual({ '❤️': 1 });
  });

  it('switches to another emoji in place — never a second row per guest', async () => {
    const result = await react(photoIds[0], '🎉');
    expect(result.updated).toBe(true);

    const rows = await db('photo_feedback')
      .where({ photo_id: photoIds[0], feedback_type: 'reaction' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reaction).toBe('🎉');
    expect(await feedbackService.getPhotoReactionCounts(photoIds[0])).toEqual({ '🎉': 1 });
  });

  it('tallies different guests per emoji', async () => {
    await react(photoIds[0], '🎉', { guestIdentifier: GUEST_B });
    expect(await feedbackService.getPhotoReactionCounts(photoIds[0])).toEqual({ '🎉': 2 });
    expect(await reactionCountOf(photoIds[0])).toBe(2);
  });

  it('toggles off with the same emoji', async () => {
    const result = await react(photoIds[0], '🎉');
    expect(result.removed).toBe(true);
    expect(await feedbackService.getPhotoReactionCounts(photoIds[0])).toEqual({ '🎉': 1 }); // GUEST_B remains
    expect(await reactionCountOf(photoIds[0])).toBe(1);
  });

  it('scopes per guest_id when present — two token-guests on one device stay independent', async () => {
    const first = await react(photoIds[1], '😍', { guestIdentifier: GUEST_A, guestId: 101 });
    const second = await react(photoIds[1], '👏', { guestIdentifier: GUEST_A, guestId: 102 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true); // NOT treated as guest 101's switch
    expect(await feedbackService.getPhotoReactionCounts(photoIds[1])).toEqual({ '😍': 1, '👏': 1 });
  });

  it('accepts every emoji of the curated set', async () => {
    for (const emoji of REACTION_EMOJIS) {
      const res = await react(photoIds[2], emoji, { guestIdentifier: `guest-${emoji}` });
      expect(res.created).toBe(true);
    }
    const counts = await feedbackService.getPhotoReactionCounts(photoIds[2]);
    expect(Object.keys(counts)).toHaveLength(REACTION_EMOJIS.length);
  });

  it('hidden reactions leave both the per-emoji tallies and reaction_count', async () => {
    const row = await db('photo_feedback')
      .where({ photo_id: photoIds[0], feedback_type: 'reaction' })
      .first();
    await feedbackService.moderateFeedback(row.id, 'hide', 1);

    expect(await feedbackService.getPhotoReactionCounts(photoIds[0])).toEqual({});
    expect(await reactionCountOf(photoIds[0])).toBe(0);

    await feedbackService.moderateFeedback(row.id, 'approve', 1);
    expect(await reactionCountOf(photoIds[0])).toBe(1);
  });

  it('toggle and switch collapse racy duplicate rows for the same guest', async () => {
    // Simulate the check-then-insert race: two rows for one guest+photo.
    const mk = (emoji) => ({
      photo_id: photoIds[1], event_id: eventId, feedback_type: 'reaction',
      reaction: emoji, guest_identifier: 'dup-guest', is_approved: true, is_hidden: false,
      created_at: new Date(), updated_at: new Date(),
    });
    await db('photo_feedback').insert([mk('❤️'), mk('❤️')]);

    // Switching converges to exactly ONE row with the new emoji…
    const switched = await react(photoIds[1], '🎉', { guestIdentifier: 'dup-guest' });
    expect(switched.updated).toBe(true);
    let rows = await db('photo_feedback')
      .where({ photo_id: photoIds[1], feedback_type: 'reaction', guest_identifier: 'dup-guest' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reaction).toBe('🎉');

    // …and toggle-off removes the full guest-scoped set.
    await db('photo_feedback').insert(mk('🎉'));
    const removed = await react(photoIds[1], '🎉', { guestIdentifier: 'dup-guest' });
    expect(removed.removed).toBe(true);
    rows = await db('photo_feedback')
      .where({ photo_id: photoIds[1], feedback_type: 'reaction', guest_identifier: 'dup-guest' });
    expect(rows).toHaveLength(0);
  });

  it('summary and exports carry reactions', async () => {
    const summary = await feedbackService.getEventFeedbackSummary(eventId);
    expect(Number(summary.stats.total_reactions)).toBeGreaterThan(0);

    const longRows = await feedbackService.exportEventFeedback(eventId);
    const longReaction = longRows.find((r) => r.feedback_type === 'reaction');
    expect(longReaction.reaction).toBeTruthy();

    const pivotRows = await feedbackService.exportEventFeedbackPivoted(eventId);
    const pivotWithReaction = pivotRows.find((r) => r.reaction);
    expect(REACTION_EMOJIS).toContain(pivotWithReaction.reaction);
  });
});
