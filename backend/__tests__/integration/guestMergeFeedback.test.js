const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

jest.mock('../../src/utils/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('guest merge feedback ownership (#1265)', () => {
  let db; let cleanup; let app; let service; let eventId; let adminId; let audit;
  let guests; let photos;
  const slug = 'guest-merge-feedback';
  const date = (hour) => `2026-09-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const guestToken = (guest) => jwt.sign(
    { eventId, guestId: guest.id, type: 'guest' }, process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const asGuest = (req, guest = guests[0]) => req
    .set('Authorization', `Bearer ${galleryToken()}`)
    .set('x-guest-token', guestToken(guest));
  const merge = (sources = [guests[1].id], keep = guests[0].id) => request(app)
    .post(`/api/admin/events/${eventId}/guests/${keep}/merge`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`)
    .send({ mergeIds: sources });
  const feedback = async (guest, photo, type = 'like', extra = {}) => {
    const [row] = await db('photo_feedback').insert({
      event_id: eventId, photo_id: photo.id, guest_id: guest.id,
      guest_identifier: guest.identifier, feedback_type: type,
      is_hidden: false, is_approved: true, created_at: date(10), updated_at: date(10),
      ...extra,
    }).returning('id');
    return row.id ?? row;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId);
    service = require('../../src/services/feedbackService');
    const [event] = await db('events').insert({
      slug, event_type: 'wedding', event_name: 'Guest merge feedback',
      event_date: '2026-09-15', host_email: 'host@example.com', admin_email: 'admin@example.com',
      password_hash: 'x', share_link: `/gallery/${slug}/share`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      is_active: true, is_archived: false, is_draft: false,
    }).returning('id');
    eventId = event.id ?? event;
    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, identity_mode: 'guest',
      allow_likes: true, allow_favorites: true, allow_ratings: true,
      allow_reactions: true, allow_color_labels: true, allow_comments: true,
      show_feedback_to_guests: false, moderate_comments: false,
    });
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    audit = jest.spyOn(require('../../src/database/db'), 'logActivity');
    app.use('/api/admin', require('../../src/routes/adminGuests'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  beforeEach(async () => {
    await db('photo_feedback').del();
    await db('guest_invites').del();
    await db('gallery_guests').del();
    await db('photos').del();
    guests = await db('gallery_guests').insert(['kept', 'source', 'source-two', 'other'].map(name => ({
      event_id: eventId, name, identifier: `guest-${name}`, email: `${name}@example.com`,
      is_deleted: false,
    }))).returning('*');
    photos = await db('photos').insert([1, 2, 3].map(n => ({
      event_id: eventId, filename: `photo-${n}.jpg`, path: `merge/photo-${n}.jpg`, type: 'individual',
    }))).returning('*');
  });

  afterAll(async () => {
    if (audit) audit.mockRestore();
    if (cleanup) await cleanup();
  });

  it('moves both identifiers and shows transferred selections as the survivor\'s own', async () => {
    const id = await feedback(guests[1], photos[0]);
    const otherId = await feedback(guests[3], photos[0]);
    const res = await merge();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merged: 1, photos: 1 });
    expect(await db('photo_feedback').where({ id }).first()).toMatchObject({
      guest_id: guests[0].id, guest_identifier: guests[0].identifier,
    });
    const photo = await asGuest(request(app).get(`/api/gallery/${slug}/photos/${photos[0].id}/feedback`));
    expect(photo.status).toBe(200);
    expect(photo.body.feedback).toEqual([expect.objectContaining({ id, is_mine: true })]);
    expect(photo.body.feedback.some(row => row.id === otherId)).toBe(false);
    const all = await asGuest(request(app).get(`/api/gallery/${slug}/my-feedback`));
    expect(all.status).toBe(200);
    expect(all.body.map(row => row.id)).toEqual([id]);
    const oldGuest = await asGuest(request(app).get(`/api/gallery/${slug}/photos/${photos[0].id}/feedback`), guests[1]);
    expect(oldGuest.status).toBe(200);
    expect(oldGuest.body.feedback).toEqual([]);
  });

  it('recognises old merged rows by verified guest_id without a data migration', async () => {
    const id = await feedback(guests[0], photos[0], 'like', { guest_identifier: 'stale-source-uuid' });
    await feedback(guests[3], photos[0]);
    const res = await asGuest(request(app).get(`/api/gallery/${slug}/photos/${photos[0].id}/feedback`));
    expect(res.status).toBe(200);
    expect(res.body.feedback).toEqual([expect.objectContaining({ id, is_mine: true })]);
    expect(await service.getPhotoFeedback(photos[0].id, { guest_identifier: 'stale-source-uuid' }))
      .toEqual([expect.objectContaining({ id })]);
    expect(await service.getPhotoFeedback(photos[0].id, {
      guest_id: guests[2].id, guest_identifier: 'stale-source-uuid',
    })).toEqual([]);
  });

  it.each(['like', 'favorite'])('keeps the union of %s selections, counts overlaps once and clears them in one click', async type => {
    for (const guest of guests.slice(0, 3)) await feedback(guest, photos[0], type);
    await feedback(guests[0], photos[1], type);
    await feedback(guests[2], photos[2], type);
    await feedback(guests[3], photos[0], type);
    const res = await merge([guests[1].id, guests[2].id]);
    expect(res.status).toBe(200);
    const rows = await db('photo_feedback').where({ guest_id: guests[0].id });
    expect(rows.map(row => row.photo_id).sort()).toEqual(photos.map(photo => photo.id).sort());
    expect((await db('photos').where({ id: photos[0].id }).first())[`${type}_count`]).toBe(2);
    const toggle = await service.submitFeedback(photos[0].id, eventId, {
      feedback_type: type, guest_id: guests[0].id,
    }, guests[0].identifier);
    expect(toggle.removed).toBe(true);
    expect(await db('photo_feedback').where({ guest_id: guests[0].id, photo_id: photos[0].id })).toHaveLength(0);
    expect((await db('photos').where({ id: photos[0].id }).first())[`${type}_count`]).toBe(1);
  });

  it.each([
    ['rating', 'rating', 2, 5, 3],
    ['reaction', 'reaction', '❤️', '🔥', '😍'],
    ['color_label', 'color_label', 'red', 'green', 'blue'],
  ])('keeps the latest %s per photo and preserves timestamps across successive merges', async (type, column, first, second, third) => {
    await feedback(guests[0], photos[0], type, { [column]: first, updated_at: date(9) });
    await feedback(guests[1], photos[0], type, { [column]: second, updated_at: date(11) });
    await feedback(guests[2], photos[0], type, { [column]: third, updated_at: date(12) });
    expect((await merge()).status).toBe(200);
    let rows = await db('photo_feedback').where({ guest_id: guests[0].id });
    expect(rows).toHaveLength(1);
    expect(rows[0][column]).toBe(second);
    expect((await merge([guests[2].id])).status).toBe(200);
    rows = await db('photo_feedback').where({ guest_id: guests[0].id });
    expect(rows).toHaveLength(1);
    expect(rows[0][column]).toBe(third);
    if (type === 'rating') {
      expect(Number((await db('photos').where({ id: photos[0].id }).first()).average_rating)).toBe(third);
    }
  });

  it('keeps comments, pending moderation and hidden rows while leaving other guests and shared labels alone', async () => {
    const visible = await feedback(guests[0], photos[0]);
    const hidden = await feedback(guests[1], photos[0], 'like', { is_hidden: true, updated_at: date(13) });
    const comment = await feedback(guests[0], photos[0], 'comment', { comment_text: 'First comment' });
    const pending = await feedback(guests[1], photos[0], 'comment', { comment_text: 'Second comment', is_approved: false });
    const other = await feedback(guests[3], photos[0]);
    const { SHARED_COLOR_LABEL_IDENTITY } = require('../../src/constants/colorLabels');
    const shared = await feedback({ id: null, identifier: SHARED_COLOR_LABEL_IDENTITY }, photos[0], 'color_label', { color_label: 'blue' });
    expect((await merge()).status).toBe(200);
    const owned = await db('photo_feedback').where({ guest_id: guests[0].id });
    expect(owned.map(row => row.id).sort()).toEqual([visible, hidden, comment, pending].sort());
    expect(owned.every(row => row.guest_identifier === guests[0].identifier)).toBe(true);
    expect(Boolean(owned.find(row => row.id === hidden).is_hidden)).toBe(true);
    expect(Boolean(owned.find(row => row.id === pending).is_approved)).toBe(false);
    expect((await db('photo_feedback').where({ id: other }).first()).guest_id).toBe(guests[3].id);
    expect((await db('photo_feedback').where({ id: shared }).first()).guest_identifier).toBe(SHARED_COLOR_LABEL_IDENTITY);
    expect((await db('photos').where({ id: photos[0].id }).first()).like_count).toBe(2);
  });

  it.each(['like', 'favorite'])('clears duplicate %s rows from old merges without deleting hidden or other guests\' rows', async type => {
    await feedback(guests[0], photos[0], type);
    await feedback(guests[0], photos[0], type, { guest_identifier: 'old-merged-source' });
    const hidden = await feedback(guests[0], photos[0], type, { is_hidden: true });
    const other = await feedback(guests[3], photos[0], type);
    expect(await service.submitFeedback(photos[0].id, eventId, {
      feedback_type: type, guest_id: guests[0].id,
    }, guests[0].identifier)).toMatchObject({ removed: true });
    expect((await db('photo_feedback').select('id')).map(row => row.id).sort()).toEqual([hidden, other].sort());
  });

  it('rolls back rewritten identities, deduplication and counters if recalculation fails', async () => {
    await feedback(guests[0], photos[0]);
    await feedback(guests[1], photos[0]);
    await feedback(guests[1], photos[1]);
    await db('guest_invites').insert({
      event_id: eventId, guest_id: guests[1].id, token: 'pending-merge-invite', created_by_admin_id: adminId,
    });
    const before = await db('photo_feedback').orderBy('id');
    const beforePhotos = await db('photos').orderBy('id');
    const recalculate = service.updatePhotoFeedbackStats.bind(service);
    const spy = jest.spyOn(service, 'updatePhotoFeedbackStats')
      .mockImplementationOnce(recalculate)
      .mockRejectedValueOnce(new Error('Forced stats failure'));
    try { expect((await merge()).status).toBe(500); } finally { spy.mockRestore(); }
    expect(await db('photo_feedback').orderBy('id')).toEqual(before);
    expect(await db('photos').orderBy('id')).toEqual(beforePhotos);
    expect(Boolean((await db('gallery_guests').where({ id: guests[1].id }).first()).is_deleted)).toBe(false);
    expect((await db('guest_invites').where({ token: 'pending-merge-invite' }).first()).guest_id).toBe(guests[1].id);
  });

  it('rolls back the entire merge if a later step fails after moving invites and deleting guests', async () => {
    await feedback(guests[1], photos[0]);
    await db('gallery_guests').where({ id: guests[0].id }).update({ email: ' KEPT@Example.com ' });
    await db('guest_invites').insert({
      event_id: eventId, guest_id: guests[1].id, token: 'rollback-invite', created_by_admin_id: adminId,
    });
    const before = await db('photo_feedback').orderBy('id');
    const beforeGuests = await db('gallery_guests').orderBy('id');
    audit.mockRejectedValueOnce(new Error('Forced final-step failure'));
    expect((await merge()).status).toBe(500);
    expect(await db('photo_feedback').orderBy('id')).toEqual(before);
    expect(await db('gallery_guests').orderBy('id')).toEqual(beforeGuests);
    expect((await db('guest_invites').where({ token: 'rollback-invite' }).first()).guest_id).toBe(guests[1].id);
  });

  it('rejects deleted merge targets and normalises IDs before checking for self-merges', async () => {
    await feedback(guests[1], photos[0]);
    expect((await merge([String(guests[0].id)]))).toMatchObject({ status: 400 });
    await db('gallery_guests').where({ id: guests[0].id }).update({ is_deleted: true });
    expect((await merge())).toMatchObject({ status: 400 });
    expect((await db('photo_feedback').first()).guest_id).toBe(guests[1].id);
  });
});
