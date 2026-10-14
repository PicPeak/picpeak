/** A gallery session opened before a rename carries over to the new slug. */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('../integration/helpers/crmDb');
process.env.JWT_SECRET = 'renamed-gallery-session-test-secret-with-32-plus-chars';
let db, cleanup, app, eventId, otherEventId, customerId, adminId;
const oldSlug = 'summer-party';
const newSlug = 'summer-party-2026';
const iatAgo = (s) => Math.floor(Date.now() / 1000) - s;
const gallery = (claims = {}) => jwt.sign({ type: 'gallery', eventId, eventSlug: oldSlug, iat: iatAgo(60),
  exp: iatAgo(-4 * 3600), jti: crypto.randomUUID(), ...claims }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
const session = (cookies, slug = newSlug) => request(app).get(`/api/auth/session?slug=${slug}`)
  .set('Cookie', Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; '));
const setCookies = (res) => res.headers['set-cookie'] || [];
const cookieValue = (res, name) => {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  return line ? decodeURIComponent(line.slice(name.length + 1).split(';')[0]) : undefined;
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  const create = require('../../src/services/eventCreationService').createEvent;
  const base = { event_type: 'wedding', event_date: '2026-10-01', password: 'Rename-Strong-Password-924!',
    expiration_days: 30, customer_email: 'customer@example.test', admin_email: 'admin@example.test' };
  eventId = (await create({ ...base, event_name: 'Summer party', slug: newSlug }, { actor: { id: adminId }, source: 'v1' })).id;
  otherEventId = (await create({ ...base, event_name: 'Other gallery', slug: 'other-gallery' }, { actor: { id: adminId }, source: 'v1' })).id;
  await db('events').where({ id: eventId }).update({ slug: newSlug });
  app = buildRouteApp('/api/auth', require('../../src/routes/auth'));
}, 120000);
beforeEach(async () => {
  await db('events').where({ id: eventId }).update({ is_active: 1, is_archived: 0, is_draft: 0,
    gallery_password_changed_at: null, expires_at: new Date(Date.now() + 86400000).toISOString() });
  await require('../../src/utils/sessionCutoff').setSessionsValidAfter(0);
});
afterAll(async () => {
  await require('../../src/services/serviceShutdown').stopServices();
  if (cleanup) await cleanup();
});

it('re-issues the old-slug session for the new slug with the same claims', async () => {
  const old = gallery({ accessLevel: 'client' });
  const res = await session({ [`gallery_token_${oldSlug}`]: old });
  expect(res.body).toMatchObject({ valid: true, type: 'gallery', eventSlug: newSlug, accessLevel: 'client' });

  const renewed = cookieValue(res, `gallery_token_${newSlug}`);
  expect(renewed).toBeDefined();
  const before = jwt.decode(old);
  const after = jwt.verify(renewed, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
  expect(after).toEqual({ ...before, eventSlug: newSlug });
  // The old slug's cookie is cleared.
  expect(setCookies(res).some((c) => c.startsWith(`gallery_token_${oldSlug}=;`))).toBe(true);
});

it('finds the old session through the generic gallery cookie too', async () => {
  const res = await session({ gallery_token: gallery() });
  expect(res.body).toMatchObject({ valid: true, eventSlug: newSlug });
});

it('keeps a customer-portal session a portal session', async () => {
  await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
  const res = await session({ [`gallery_token_${oldSlug}`]: gallery({ via: 'customer', customerId }) });
  expect(res.body).toMatchObject({ valid: true, eventSlug: newSlug, viaCustomer: true });
  await db('event_customer_assignments').where({ event_id: eventId }).del();
});

it.each([
  ['another gallery', () => gallery({ eventId: otherEventId })],
  ['an expired token', () => gallery({ iat: iatAgo(7200), exp: iatAgo(60) })],
  ['a revoked token', async () => {
    const token = gallery();
    await require('../../src/utils/tokenRevocation').revokeToken(token, 'test');
    return token;
  }],
  ['a gallery password change since login', async () => {
    await db('events').where({ id: eventId }).update({ gallery_password_changed_at: new Date().toISOString() });
    return gallery();
  }],
  ['a token signed with another secret', () => jwt.sign({ type: 'gallery', eventId, eventSlug: oldSlug },
    'some-other-secret-that-is-at-least-32-characters', { issuer: 'picpeak-auth', expiresIn: '1h' })],
])('does not carry over %s', async (_label, make) => {
  const res = await session({ [`gallery_token_${oldSlug}`]: await make() });
  expect(res.body.eventSlug).not.toBe(newSlug);
  expect(cookieValue(res, `gallery_token_${newSlug}`)).toBeUndefined();
});

it('leaves a session already on the new slug alone', async () => {
  const current = gallery({ eventSlug: newSlug });
  const res = await session({ [`gallery_token_${newSlug}`]: current });
  expect(res.body).toMatchObject({ valid: true, eventSlug: newSlug });
  expect(setCookies(res)).toEqual([]);
});
