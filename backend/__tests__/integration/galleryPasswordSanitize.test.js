/**
 * Gallery password invisible-Unicode fallback (#654).
 *
 * Passwords relayed through chat apps (Instagram DMs especially) pick up
 * invisible characters on copy-paste — zero-width space/joiners, word
 * joiner, BOM, soft hyphen — which fail the byte-exact bcrypt compare and
 * surface as "incorrect password" for a correct password. The verify route
 * retries the compare with those characters stripped, in the SAME request,
 * so the fallback costs no reCAPTCHA token and no failed-attempt quota.
 *
 * Pins the contract:
 *  - exact submitted bytes always win first, so stored passwords that
 *    legitimately contain these characters (e.g. ZWJ emoji sequences)
 *    keep working
 *  - paste artifacts (mid-string ZWSP, leading BOM, trailing space) are
 *    rescued by the sanitized fallback compare
 *  - the fallback never invents a match (missing ZWJ still 401s), and a
 *    rescued login records no failed attempt
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sanitize-test-secret';

const PLAIN_SLUG = 'sanitize-plain-event';
const ZWJ_SLUG = 'sanitize-zwj-event';
const PLAIN_PASSWORD = 'wedding2026';
// Stored password legitimately containing a ZWJ emoji sequence.
const ZWJ_PASSWORD = 'Family\u{1F468}\u200D\u{1F469}Aa1';

describe('gallery/verify invisible-Unicode fallback (#654)', () => {
  let db;
  let cleanup;
  let app;

  const makeEvent = async (slug, password) => {
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Sanitize ${slug}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: await bcrypt.hash(password, 4),
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };
  let plainEventId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    plainEventId = await makeEvent(PLAIN_SLUG, PLAIN_PASSWORD);
    await makeEvent(ZWJ_SLUG, ZWJ_PASSWORD);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', require('../../src/routes/auth'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  const verify = (slug, password) =>
    request(app).post('/api/auth/gallery/verify').send({ slug, password });

  it('accepts the exact password', async () => {
    const res = await verify(PLAIN_SLUG, PLAIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('rescues a mid-string zero-width space from chat-app copy-paste', async () => {
    const res = await verify(PLAIN_SLUG, 'wedding\u200B2026');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('rescues leading BOM + trailing space paste artifacts', async () => {
    const res = await verify(PLAIN_SLUG, `\uFEFF${PLAIN_PASSWORD} `);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('records no login_fail for a rescued login (single-request fallback)', async () => {
    await verify(PLAIN_SLUG, 'wedding\u200B2026').expect(200);
    const failed = await db('access_logs')
      .where({ event_id: plainEventId, action: 'login_fail' });
    expect(failed).toHaveLength(0);
  });

  it('still accepts a stored password that legitimately contains a ZWJ', async () => {
    const res = await verify(ZWJ_SLUG, ZWJ_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('does not invent a match when the ZWJ is missing from the input', async () => {
    const res = await verify(ZWJ_SLUG, 'Family\u{1F468}\u{1F469}Aa1');
    expect(res.status).toBe(401);
  });

  it('rejects a plain wrong password', async () => {
    const res = await verify(PLAIN_SLUG, 'not-the-password');
    expect(res.status).toBe(401);
  });
});
