/**
 * PUT /api/admin/business-profile — email signature fields (migration 198).
 *
 * The two new columns are boolean + free text, which is exactly the shape
 * that goes wrong quietly: `optional({ values: 'falsy' })` on the boolean
 * would silently drop `false`, leaving the admin unable to switch the
 * signature back off. The round-trip below is what pins that.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-bpsig-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bpsig-route-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

describe('business profile — email signature round-trip', () => {
  let db;
  let cleanup;
  let app;
  let token;

  const put = (payload) => request(app)
    .put('/api/admin/business-profile')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);

  const get = () => request(app)
    .get('/api/admin/business-profile')
    .set('Authorization', `Bearer ${token}`);

  // GET returns the snapshot at the top level; PUT wraps it in
  // successResponse's `data` envelope. Read either.
  const profileOf = (res) => (res.body.data || res.body).profile;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = buildRouteApp('/api/admin/business-profile', require('../../src/routes/adminBusinessProfile'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('defaults to off with an empty legal line', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const profile = profileOf(res);
    expect(profile.emailSignatureEnabled).toBe(false);
    expect(profile.emailSignatureExtra).toBe('');
  });

  it('persists the toggle and the legal line', async () => {
    const res = await put({
      emailSignatureEnabled: true,
      emailSignatureExtra: 'Handelsregister Vaduz FL-0002.123.456-7',
    });
    expect(res.status).toBe(200);

    const profile = profileOf(await get());
    expect(profile.emailSignatureEnabled).toBe(true);
    expect(profile.emailSignatureExtra).toBe('Handelsregister Vaduz FL-0002.123.456-7');
  });

  it('switches the toggle back off — `false` is not dropped as falsy', async () => {
    await put({ emailSignatureEnabled: true });
    const res = await put({ emailSignatureEnabled: false });
    expect(res.status).toBe(200);

    expect(profileOf(await get()).emailSignatureEnabled).toBe(false);
  });

  it('clears the legal line with an empty string', async () => {
    await put({ emailSignatureExtra: 'something' });
    const res = await put({ emailSignatureExtra: '' });
    expect(res.status).toBe(200);

    expect(profileOf(await get()).emailSignatureExtra).toBe('');
  });

  it('trims surrounding whitespace off the legal line', async () => {
    await put({ emailSignatureExtra: '  Registered in Vaduz  ' });
    expect(profileOf(await get()).emailSignatureExtra).toBe('Registered in Vaduz');
  });

  // Codex review: express-validator's isBoolean() accepts the STRINGS
  // 'false' and '0', and Boolean('false') is true — so a form-encoded client
  // trying to switch the signature OFF switched it on instead.
  it.each([['false'], ['0']])('treats the string %s as off, not on', async (value) => {
    await put({ emailSignatureEnabled: true });
    expect(profileOf(await get()).emailSignatureEnabled).toBe(true);

    const res = await put({ emailSignatureEnabled: value });
    expect(res.status).toBe(200);
    expect(profileOf(await get()).emailSignatureEnabled).toBe(false);
  });

  it.each([['true'], ['1']])('treats the string %s as on', async (value) => {
    await put({ emailSignatureEnabled: false });
    const res = await put({ emailSignatureEnabled: value });
    expect(res.status).toBe(200);
    expect(profileOf(await get()).emailSignatureEnabled).toBe(true);
  });

  it('rejects a non-boolean toggle and a legal line over 500 chars', async () => {
    expect((await put({ emailSignatureEnabled: 'yes please' })).status).toBe(400);
    expect((await put({ emailSignatureExtra: 'x'.repeat(501) })).status).toBe(400);
  });

  it('does not let an unmapped column ride in on the payload', async () => {
    // ALLOWED_PROFILE_FIELDS is the whitelist; the route's camel→snake map
    // is the second gate. Neither should pass a raw snake_case key through.
    const before = await db('business_profile').where({ id: 1 }).first();
    await put({ email_signature_enabled: true, id: 999 });
    const after = await db('business_profile').where({ id: 1 }).first();

    expect(after.id).toBe(before.id);
    expect(after.email_signature_enabled).toBe(before.email_signature_enabled);
  });

  it('invalidates the wrapper signature cache on write', async () => {
    const { wrapEmailHtml } = require('../../src/services/emailProcessor');

    await put({ emailSignatureEnabled: false });
    expect(await wrapEmailHtml('<p>x</p>', 'S')).not.toContain('Bahnhofstrasse 9');

    // Same request cycle, well inside the 60 s memo window: the PUT must
    // clear the cache or the operator sees a stale footer for a minute.
    await put({ emailSignatureEnabled: true, addressLine1: 'Bahnhofstrasse 9' });
    expect(await wrapEmailHtml('<p>x</p>', 'S')).toContain('Bahnhofstrasse 9');
  });
});
