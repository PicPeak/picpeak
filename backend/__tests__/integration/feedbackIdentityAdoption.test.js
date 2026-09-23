/**
 * Legacy anonymous feedback identity adoption (#1584).
 *
 * PR #1571 replaced the anonymous guest identifier — sha256("ip:userAgent")
 * — with a signed `picpeak_feedback` cookie. Rows written under the old hash
 * were never migrated, so a returning anonymous guest was a stranger to
 * their own likes/ratings/favourites: the duplicate check in
 * feedbackService.submitFeedback only ever looks at the new identity.
 *
 * anonymousFeedbackIdentifier() now adopts the legacy row(s) onto the new
 * cookie identity the first time it issues a fresh cookie for a request
 * (see backend/src/utils/anonymousFeedbackIdentity.js).
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const knex = require('knex');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
let db; let cleanup; let app; let eventId; let photoId; let token; let owner; let schema;

const IP = '203.0.113.77';
const USER_AGENT = 'legacy-guest-browser/1.0';
// Must match the pre-#1571 generateGuestIdentifier exactly: sha256(`${ip}:${userAgent}`).
const legacyIdentifier = () => crypto.createHash('sha256').update(`${IP}:${USER_AGENT}`).digest('hex');

beforeAll(async () => {
  if (pgUrl) {
    schema = `feedback_identity_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const [event] = await db('events').insert({ slug: 'legacy-identity', event_type: 'wedding', event_name: 'Legacy Identity',
    event_date: '2026-09-16', host_email: 'h@example.test', admin_email: 'a@example.test',
    password_hash: 'unused', share_link: '/gallery/legacy-identity/share', is_active: true, is_archived: false, is_draft: false }).returning('id');
  eventId = event.id ?? event;
  const [photo] = await db('photos').insert({ event_id: eventId, filename: 'legacy.jpg', path: 'legacy.jpg', type: 'individual' }).returning('id');
  photoId = photo.id ?? photo;
  await db('event_feedback_settings').insert({ event_id: eventId, feedback_enabled: true, identity_mode: 'simple',
    allow_likes: true, allow_favorites: true, moderate_comments: false, require_moderation: false });
  app = express();
  // trust proxy: lets X-Forwarded-For below pin req.ip to a known value, so
  // the legacy sha256(ip:userAgent) hash this suite seeds is reproducible.
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  token = jwt.sign({ eventId, eventSlug: 'legacy-identity', type: 'gallery', jti: randomUUID() }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
});

afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});

beforeEach(async () => { await db('photo_feedback').where({ photo_id: photoId }).delete(); });

const seedLegacyRow = (feedbackType, guestIdentifier = legacyIdentifier()) => {
  const now = new Date().toISOString();
  return db('photo_feedback').insert({
    photo_id: photoId, event_id: eventId, feedback_type: feedbackType,
    guest_identifier: guestIdentifier, is_hidden: false, is_approved: true,
    created_at: now, updated_at: now,
  }).returning('id').then(([row]) => row.id ?? row);
};

test('re-keys a legacy IP+UA row onto the new cookie identity on first contact, and the duplicate check sees it', async () => {
  const legacyRowId = await seedLegacyRow('like');

  const client = request.agent(app);
  // Same IP + User-Agent as the legacy hash, but no picpeak_feedback cookie:
  // this is exactly the request shape of a returning anonymous guest after
  // the #1571 upgrade. Read-only, so it isolates adoption from submission.
  const getRes = await client
    .get(`/api/gallery/legacy-identity/photos/${photoId}/feedback`)
    .set('Authorization', `Bearer ${token}`)
    .set('User-Agent', USER_AGENT)
    .set('X-Forwarded-For', IP)
    .expect(200);

  // A fresh cookie was issued (no valid one was presented).
  expect(getRes.headers['set-cookie']?.[0]).toContain('picpeak_feedback');

  // The legacy row is now filed under the new cookie identity, not the old hash.
  const rekeyed = await db('photo_feedback').where({ id: legacyRowId }).first();
  expect(rekeyed.guest_identifier).not.toBe(legacyIdentifier());
  expect(rekeyed.guest_identifier).toMatch(/^[a-f0-9]{64}$/);

  // Submitting 'like' again, now carrying the adopted cookie: submitFeedback's
  // duplicate check found the (re-keyed) existing row and toggled it off —
  // it did NOT fail to see the old row and insert a second one. Before the
  // fix this was exactly the "count goes up by two" bug from #1584.
  const postRes = await client
    .post(`/api/gallery/legacy-identity/photos/${photoId}/feedback`)
    .set('Authorization', `Bearer ${token}`)
    .set('User-Agent', USER_AGENT)
    .set('X-Forwarded-For', IP)
    .send({ feedback_type: 'like' })
    .expect(200);
  expect(postRes.body).toMatchObject({ success: true, removed: true });

  const likeRows = await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'like' });
  expect(likeRows).toHaveLength(0); // toggled off — never duplicated to 2
});

test('a second like from the now-adopted identity is recognized as the same guest, not a stranger', async () => {
  await seedLegacyRow('rating');
  await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'rating' }).update({ rating: 4 });

  const client = request.agent(app);
  // First contact adopts the legacy rating row onto a fresh cookie.
  await client
    .get(`/api/gallery/legacy-identity/photos/${photoId}/feedback`)
    .set('Authorization', `Bearer ${token}`)
    .set('User-Agent', USER_AGENT)
    .set('X-Forwarded-For', IP)
    .expect(200);

  // Submitting the SAME rating again, now carrying the adopted cookie, must
  // be recognized as a duplicate of the guest's own existing row — not
  // inserted as a second row for what the app-level dedup treats as a
  // one-per-guest-per-photo value.
  const res = await client
    .post(`/api/gallery/legacy-identity/photos/${photoId}/feedback`)
    .set('Authorization', `Bearer ${token}`)
    .set('User-Agent', USER_AGENT)
    .set('X-Forwarded-For', IP)
    .send({ feedback_type: 'rating', rating: 4 })
    .expect(200);

  expect(res.body).toMatchObject({ success: true, exists: true });
  const ratingRows = await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'rating' });
  expect(ratingRows).toHaveLength(1); // still just the one, adopted row
});

test('leaves a legacy row alone when the new identity already holds a row for that photo/action', async () => {
  const { anonymousFeedbackIdentifier } = require('../../src/utils/anonymousFeedbackIdentity');

  // Force a deterministic new identity so we can pre-seed a collision under
  // it: the identity a fresh cookie mints depends on a random subject.
  const fixedSubject = 'b'.repeat(32);
  const randomBytesSpy = jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from(fixedSubject, 'hex'));
  try {
    const expectedIdentifier = crypto.createHmac('sha256', process.env.JWT_SECRET)
      .update(`feedback:${eventId}:${fixedSubject}`).digest('hex');

    const legacyRowId = await seedLegacyRow('favorite');
    const collisionRowId = await seedLegacyRow('favorite', expectedIdentifier);

    const req = {
      event: { id: eventId }, ip: IP, headers: { 'user-agent': USER_AGENT },
      cookies: {}, res: { cookie: jest.fn() },
    };
    const identifier = await anonymousFeedbackIdentifier(req);
    expect(identifier).toBe(expectedIdentifier);

    // Neither row was touched: no merge, no delete, no crash from the
    // collision — the legacy row is simply left orphaned, same as before
    // #1571 for a guest whose IP/UA never matched again.
    const legacyAfter = await db('photo_feedback').where({ id: legacyRowId }).first();
    expect(legacyAfter.guest_identifier).toBe(legacyIdentifier());

    const collisionAfter = await db('photo_feedback').where({ id: collisionRowId }).first();
    expect(collisionAfter.guest_identifier).toBe(expectedIdentifier);

    const total = await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'favorite' });
    expect(total).toHaveLength(2);
  } finally {
    randomBytesSpy.mockRestore();
  }
});

test('adopts a guest who already holds a valid cookie from before adoption shipped, once, then never again', async () => {
  const { anonymousFeedbackIdentifier } = require('../../src/utils/anonymousFeedbackIdentity');

  // Simulates the #1584 migration-completeness gap: a cookie minted by
  // #1571, before the re-key logic in #1584 existed. isNewIdentity is false
  // on every request from here on, so the gate has to be "adoption was
  // never attempted for this subject", not "this cookie is brand new".
  const preexistingSubject = 'c'.repeat(32);
  const preexistingCookie = jwt.sign({ type: 'feedback' }, process.env.JWT_SECRET,
    { issuer: 'picpeak-feedback', subject: preexistingSubject, expiresIn: '1h' });
  const expectedIdentifier = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`feedback:${eventId}:${preexistingSubject}`).digest('hex');

  const legacyRowId = await seedLegacyRow('like');
  const req1 = { event: { id: eventId }, ip: IP, headers: { 'user-agent': USER_AGENT },
    cookies: { picpeak_feedback: preexistingCookie }, res: { cookie: jest.fn() } };
  const identifier1 = await anonymousFeedbackIdentifier(req1);
  expect(identifier1).toBe(expectedIdentifier);
  expect(req1.res.cookie).not.toHaveBeenCalled(); // already had a valid cookie — none re-issued

  expect(await db('feedback_identity_adoptions').where({ subject: preexistingSubject }).first()).toBeTruthy();
  expect((await db('photo_feedback').where({ id: legacyRowId }).first()).guest_identifier).toBe(expectedIdentifier);

  // A later legacy-shaped row shows up under the same IP/UA (e.g. another
  // stray pre-cookie write). Adoption must not run again for this subject.
  const laterLegacyRowId = await seedLegacyRow('favorite');
  const req2 = { event: { id: eventId }, ip: IP, headers: { 'user-agent': USER_AGENT },
    cookies: { picpeak_feedback: preexistingCookie }, res: { cookie: jest.fn() } };
  const identifier2 = await anonymousFeedbackIdentifier(req2);
  expect(identifier2).toBe(expectedIdentifier);
  expect((await db('photo_feedback').where({ id: laterLegacyRowId }).first()).guest_identifier).toBe(legacyIdentifier());
});

test('two concurrent first-contact requests from the same browser re-key the legacy row exactly once', async () => {
  const { anonymousFeedbackIdentifier } = require('../../src/utils/anonymousFeedbackIdentity');
  const legacyRowId = await seedLegacyRow('like');

  const makeConcurrentReq = () => ({ event: { id: eventId }, ip: IP, headers: { 'user-agent': USER_AGENT },
    cookies: {}, res: { cookie: jest.fn() } });
  const req1 = makeConcurrentReq();
  const req2 = makeConcurrentReq();

  // Two tabs with no cookie yet, sharing IP/UA: each mints its own new
  // subject. Without locking around the legacy-row lookup + update, both
  // could re-key (or corrupt) the same row.
  const [identifier1, identifier2] = await Promise.all([
    anonymousFeedbackIdentifier(req1),
    anonymousFeedbackIdentifier(req2),
  ]);
  expect(identifier1).not.toBe(identifier2);

  const rekeyed = await db('photo_feedback').where({ id: legacyRowId }).first();
  expect([identifier1, identifier2]).toContain(rekeyed.guest_identifier); // exactly one racer won it

  const rows = await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'like' });
  expect(rows).toHaveLength(1); // no duplication from the race
});

test('batches the collision check across several legacy rows without an incorrect merge', async () => {
  const { anonymousFeedbackIdentifier } = require('../../src/utils/anonymousFeedbackIdentity');
  const [photo2] = await db('photos')
    .insert({ event_id: eventId, filename: 'legacy2.jpg', path: 'legacy2.jpg', type: 'individual' })
    .returning('id');
  const photoId2 = photo2.id ?? photo2;

  const fixedSubject = 'e'.repeat(32);
  const randomBytesSpy = jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from(fixedSubject, 'hex'));
  try {
    const expectedIdentifier = crypto.createHmac('sha256', process.env.JWT_SECRET)
      .update(`feedback:${eventId}:${fixedSubject}`).digest('hex');
    const now = new Date().toISOString();
    const insertRow = (overrides) => db('photo_feedback').insert({
      event_id: eventId, is_hidden: false, is_approved: true, created_at: now, updated_at: now, ...overrides,
    }).returning('id').then(([row]) => row.id ?? row);

    // Photo 1: no collision — must be re-keyed.
    const freeRowId = await seedLegacyRow('like');
    // Photo 2: a 'favorite' collision with the new identity — must be left alone.
    const collidingLegacyId = await insertRow({ photo_id: photoId2, feedback_type: 'favorite', guest_identifier: legacyIdentifier() });
    await insertRow({ photo_id: photoId2, feedback_type: 'favorite', guest_identifier: expectedIdentifier });
    // A comment on the same photo, under the same legacy identifier: comments
    // are never deduplicated, so it must re-key despite the favorite collision.
    const commentId = await insertRow({ photo_id: photoId2, feedback_type: 'comment', guest_identifier: legacyIdentifier(), comment_text: 'hi' });

    const req = { event: { id: eventId }, ip: IP, headers: { 'user-agent': USER_AGENT }, cookies: {}, res: { cookie: jest.fn() } };
    expect(await anonymousFeedbackIdentifier(req)).toBe(expectedIdentifier);

    expect((await db('photo_feedback').where({ id: freeRowId }).first()).guest_identifier).toBe(expectedIdentifier);
    expect((await db('photo_feedback').where({ id: collidingLegacyId }).first()).guest_identifier).toBe(legacyIdentifier());
    expect((await db('photo_feedback').where({ id: commentId }).first()).guest_identifier).toBe(expectedIdentifier);
  } finally {
    randomBytesSpy.mockRestore();
    await db('photo_feedback').where({ photo_id: photoId2 }).delete();
  }
});

const cookieFor = (subject) => jwt.sign({ type: 'feedback' }, process.env.JWT_SECRET,
  { issuer: 'picpeak-feedback', subject, expiresIn: '1h' });
const identifierFor = (subject, forEventId) => crypto.createHmac('sha256', process.env.JWT_SECRET)
  .update(`feedback:${forEventId}:${subject}`).digest('hex');

test('adopts per event: one cookie subject visiting two galleries adopts the legacy rows in each', async () => {
  const { anonymousFeedbackIdentifier } = require('../../src/utils/anonymousFeedbackIdentity');
  // The cookie is scoped to /api/gallery, so one subject spans every event,
  // and the legacy sha256(ip:userAgent) hash names none. A claim keyed on the
  // subject alone would adopt the first gallery and skip the second forever.
  const [eventB] = await db('events').insert({ slug: 'legacy-identity-b', event_type: 'wedding', event_name: 'Legacy Identity B',
    event_date: '2026-09-16', host_email: 'h@example.test', admin_email: 'a@example.test',
    password_hash: 'unused', share_link: '/gallery/legacy-identity-b/share', is_active: true, is_archived: false, is_draft: false }).returning('id');
  const eventIdB = eventB.id ?? eventB;
  const [photoB] = await db('photos').insert({ event_id: eventIdB, filename: 'legacy-b.jpg', path: 'legacy-b.jpg', type: 'individual' }).returning('id');
  const photoIdB = photoB.id ?? photoB;
  try {
    const subject = 'd'.repeat(32);
    const legacyRowA = await seedLegacyRow('like');
    const now = new Date().toISOString();
    const [rowB] = await db('photo_feedback').insert({ photo_id: photoIdB, event_id: eventIdB, feedback_type: 'like',
      guest_identifier: legacyIdentifier(), is_hidden: false, is_approved: true, created_at: now, updated_at: now }).returning('id');
    const legacyRowB = rowB.id ?? rowB;

    const reqFor = (id) => ({ event: { id }, ip: IP, headers: { 'user-agent': USER_AGENT },
      cookies: { picpeak_feedback: cookieFor(subject) }, res: { cookie: jest.fn() } });
    expect(await anonymousFeedbackIdentifier(reqFor(eventId))).toBe(identifierFor(subject, eventId));
    expect(await anonymousFeedbackIdentifier(reqFor(eventIdB))).toBe(identifierFor(subject, eventIdB));

    expect((await db('photo_feedback').where({ id: legacyRowA }).first()).guest_identifier).toBe(identifierFor(subject, eventId));
    expect((await db('photo_feedback').where({ id: legacyRowB }).first()).guest_identifier).toBe(identifierFor(subject, eventIdB));
    expect(await db('feedback_identity_adoptions').where({ subject })).toHaveLength(2);
  } finally {
    await db('photo_feedback').where({ event_id: eventIdB }).delete();
    await db('photos').where({ id: photoIdB }).delete();
    await db('feedback_identity_adoptions').where({ event_id: eventIdB }).delete();
    await db('events').where({ id: eventIdB }).delete();
  }
});

test('a failed re-key leaves no adoption claim behind, so the next request adopts', async () => {
  const { anonymousFeedbackIdentifier } = require('../../src/utils/anonymousFeedbackIdentity');
  const subject = 'f'.repeat(32);
  const legacyRowId = await seedLegacyRow('like');
  const reqFn = () => ({ event: { id: eventId }, ip: IP, headers: { 'user-agent': USER_AGENT },
    cookies: { picpeak_feedback: cookieFor(subject) }, res: { cookie: jest.fn() } });

  // Inside adoption, toISOString is called once for the claim's adopted_at
  // and once for the re-key UPDATE's updated_at: fail the second, after the
  // claim row has already been written in the same transaction.
  const realToISOString = Date.prototype.toISOString;
  let calls = 0;
  const spy = jest.spyOn(Date.prototype, 'toISOString').mockImplementation(function () {
    calls += 1;
    if (calls === 2) throw new Error('forced re-key failure');
    return realToISOString.call(this);
  });
  try {
    // Feedback identity still resolves: adoption is best-effort.
    expect(await anonymousFeedbackIdentifier(reqFn())).toBe(identifierFor(subject, eventId));
  } finally {
    spy.mockRestore();
  }
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(await db('feedback_identity_adoptions').where({ subject, event_id: eventId }).first()).toBeFalsy();
  expect((await db('photo_feedback').where({ id: legacyRowId }).first()).guest_identifier).toBe(legacyIdentifier());

  expect(await anonymousFeedbackIdentifier(reqFn())).toBe(identifierFor(subject, eventId));
  expect(await db('feedback_identity_adoptions').where({ subject, event_id: eventId }).first()).toBeTruthy();
  expect((await db('photo_feedback').where({ id: legacyRowId }).first()).guest_identifier).toBe(identifierFor(subject, eventId));
});
