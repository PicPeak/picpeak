const request = require('supertest');
const jwt = require('jsonwebtoken');
const knex = require('knex');
const { randomUUID, createHash } = require('crypto');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('./helpers/crmDb');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
let db; let cleanup; let app; let eventId; let photoId; let token; let owner; let schema;
beforeAll(async () => {
  if (pgUrl) {
    schema = `feedback_limits_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const [event] = await db('events').insert({ slug: 'limits', event_type: 'wedding', event_name: 'Limits',
    event_date: '2026-09-16', host_email: 'h@example.test', admin_email: 'a@example.test',
    password_hash: 'unused', share_link: '/gallery/limits/share', is_active: true, is_archived: false, is_draft: false }).returning('id');
  eventId = event.id ?? event;
  const [photo] = await db('photos').insert({ event_id: eventId, filename: 'test.jpg', path: 'test.jpg', type: 'individual' }).returning('id');
  photoId = photo.id ?? photo;
  await db('event_feedback_settings').insert({ event_id: eventId, feedback_enabled: true, identity_mode: 'simple',
    allow_comments: true, allow_likes: true, moderate_comments: false, require_moderation: false });
  await db('app_settings').where({ setting_key: 'feedback_rate_limits' }).update({
    setting_value: JSON.stringify({ comment: { max: 3, window: 3600 } })
  });
  app = buildRouteApp('/api/gallery', require('../../src/routes/galleryFeedback'));
  token = jwt.sign({ eventId, eventSlug: 'limits', type: 'gallery', jti: randomUUID() }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
});
afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});
beforeEach(async () => { await db('feedback_rate_limits').delete(); await db('photo_feedback').delete(); });
const post = (client, data, ua = 'browser-one') => client.post(`/api/gallery/limits/photos/${photoId}/feedback`)
  .set('Authorization', `Bearer ${token}`).set('User-Agent', ua).send(data);
const comment = (text, extra = {}) => ({ feedback_type: 'comment', comment_text: text, ...extra });

test('caller event IDs cannot move the reservation away from the authenticated gallery', async () => {
  const client = request.agent(app);
  for (let i = 0; i < 3; i++) await post(client, comment(`Comment ${i}`)).expect(200);
  await post(client, comment('Blocked', { event_id: 999999 })).expect(429);
  await post(client, comment('Still blocked', { event_id: null })).expect(429);
  expect(Number((await db('photo_feedback').count('* as n').first()).n)).toBe(3);
  expect((await db('feedback_rate_limits').distinct('event_id')).map(row => row.event_id)).toEqual([eventId]);
});

test('rotating the User-Agent keeps one browser identity and cannot inflate likes', async () => {
  const client = request.agent(app);
  for (let i = 0; i < 5; i++) {
    const res = await post(client, { feedback_type: 'like' }, `browser-${i}`).expect(200);
    if (i === 0) expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
  }
  expect(Number((await db('photo_feedback').where({ feedback_type: 'like' }).count('* as n').first()).n)).toBe(1);
  expect((await db('feedback_rate_limits').distinct('identifier')).length).toBe(2); // browser + IP
});

test('parallel attempts cannot all pass a nearly exhausted budget', async () => {
  const client = request.agent(app);
  await post(client, comment('Initial')).expect(200);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => post(client, comment(`Concurrent ${i}`))));
  expect(responses.filter(res => res.status === 200)).toHaveLength(2);
  expect(responses.filter(res => res.status === 429)).toHaveLength(6);
  expect(Number((await db('photo_feedback').count('* as n').first()).n)).toBe(3);
});

test('counter storage failure prevents the feedback write', async () => {
  await db.schema.renameTable('feedback_rate_limits', 'feedback_rate_limits_unavailable');
  try {
    await post(request(app), comment('Unavailable')).expect(503);
    expect(Number((await db('photo_feedback').count('* as n').first()).n)).toBe(0);
  } finally { await db.schema.renameTable('feedback_rate_limits_unavailable', 'feedback_rate_limits'); }
});

test('discarding browser cookies does not bypass the independent IP budget', async () => {
  await post(request(app), comment('Discover listener address')).expect(200);
  const ip = require('../../src/utils/rateLimitKey').rateLimitKey({ ip: (await db('photo_feedback').first()).ip_address });
  await db('feedback_rate_limits').delete();
  await db('feedback_rate_limits').insert({ event_id: eventId, action_type: 'comment', action_count: 200,
    identifier: createHash('sha256').update(`feedback-ip:${ip}`).digest('hex'), window_start: new Date() });
  await post(request(app), comment('New browser'), 'fresh-browser').expect(429);
});

test('verified guest identities retain their server-issued identifiers', async () => {
  const { generateGuestIdentifier } = require('../../src/middleware/feedbackRateLimit');
  expect(await generateGuestIdentifier({ guest: { identifier: 'verified-guest' } })).toBe('verified-guest');
});


test('the sweep cutoff matches consumeFeedbackLimit\'s window_start insert convention (#1585)', async () => {
  // window_start is `table.timestamp(...)`; on SQLite that gives the column
  // NUMERIC affinity, and consumeFeedbackLimit() (unchanged by this PR, see
  // ~line 101) inserts window_start as a plain `Date`. A previous revision
  // of the sweep computed its cutoff as `new Date(...).toISOString()` — a
  // TEXT value. Comparing a TEXT cutoff against a NUMERIC-affinity column
  // falls back to SQLite's storage-class sort order, where every INTEGER
  // sorts below every TEXT value, so `window_start < cutoff` was true for
  // EVERY row unconditionally: the sweep silently deleted the whole table
  // on every run.
  //
  // We assert on the actual bound parameter — captured via knex's `query`
  // event, before it reaches the driver — rather than on deleted/stored
  // row values. Under Jest, sqlite3's native binding loses realm identity
  // for a `Date` created inside the sandbox and mangles it into the
  // literal string "[object Object]" (see CLAUDE.md's "Jest + SQLite date
  // landmine"); that quirk is Jest-sandbox-only and would make a
  // value-level round-trip assertion pass or fail for reasons unrelated to
  // this bug. Checking the bound parameter's type sidesteps that quirk
  // entirely and pins the exact regression: a string cutoff here fails
  // against the original bug and a `Date` cutoff passes against the fix,
  // on both SQLite and PostgreSQL.
  const { sweepStaleFeedbackRateLimits } = require('../../src/middleware/feedbackRateLimit');
  const captured = [];
  const onQuery = (query) => {
    if (/delete from .*feedback_rate_limits.*where.*window_start.*</is.test(query.sql)) captured.push(query);
  };
  db.on('query', onQuery);
  try {
    await sweepStaleFeedbackRateLimits();
  } finally {
    db.removeListener('query', onQuery);
  }
  expect(captured).toHaveLength(1);
  expect(captured[0].bindings[0]).toBeInstanceOf(Date);
});

// Real end-to-end row-count coverage: only meaningful against a genuine
// Postgres timestamptz column, which infers/casts its bound parameter from
// column context regardless of the caller's realm. Against SQLite under
// Jest the cutoff-type test above is the guard — see its comment for why a
// value-level assertion here would be unreliable for reasons unrelated to
// the bug being fixed. CI always provides PICPEAK_PG_TEST_URL (see
// .github/workflows/tests.yml), so this still runs on every PR.
(pgUrl ? test : test.skip)('the sweep removes rows past 2x the widest configured window and keeps fresh ones (#1585)', async () => {
  const { sweepStaleFeedbackRateLimits } = require('../../src/middleware/feedbackRateLimit');
  // Widest configured window here is comment's 3600s (see beforeAll), so the
  // sweep's cutoff is 7200s ago.
  const staleRow = { event_id: eventId, action_type: 'comment', action_count: 1,
    identifier: 'stale-guest', window_start: new Date(Date.now() - 8000 * 1000) };
  const staleOtherActionRow = { event_id: eventId, action_type: 'like', action_count: 1,
    identifier: 'stale-guest-2', window_start: new Date(Date.now() - 8000 * 1000) };
  const freshRow = { event_id: eventId, action_type: 'comment', action_count: 1,
    identifier: 'fresh-guest', window_start: new Date(Date.now() - 100 * 1000) };
  await db('feedback_rate_limits').insert([staleRow, staleOtherActionRow, freshRow]);

  const deleted = await sweepStaleFeedbackRateLimits();
  expect(deleted).toBe(2);

  const remaining = await db('feedback_rate_limits').select('identifier');
  expect(remaining.map(row => row.identifier)).toEqual(['fresh-guest']);
});

test('IPv6 address rotation shares one event IP budget while another /64 stays independent', async () => {
  const { consumeFeedbackLimit } = require('../../src/middleware/feedbackRateLimit');
  const key = createHash('sha256').update('feedback-ip:2001:db8:1:2::/64').digest('hex');
  await db('feedback_rate_limits').insert({ event_id: eventId, action_type: 'comment', action_count: 200,
    identifier: key, window_start: new Date() });
  for (const ip of ['2001:db8:1:2::1', '2001:0db8:0001:0002::abcd', '[2001:db8:1:2::1234]:443']) {
    const result = await consumeFeedbackLimit({ event: { id: eventId }, guest: { identifier: randomUUID() }, ip }, 'comment');
    expect(result.limited).toBe(true);
  }
  expect((await consumeFeedbackLimit({ event: { id: eventId }, guest: { identifier: randomUUID() },
    ip: '2001:db8:1:3::1' }, 'comment')).limited).toBe(false);
});
