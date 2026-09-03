/**
 * Public newsletter unsubscribe (#1264).
 *
 * The property under test is uniformity: a valid token, a forged one, an
 * unknown customer and an already-unsubscribed customer must be
 * indistinguishable from outside. Anything that varies — status, body,
 * headers, an error page — is an oracle that turns this endpoint into a way
 * to enumerate which customer ids exist.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-unsub-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unsub-route-secret';

const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

describe('GET /api/public/newsletter/unsubscribe/:token', () => {
  let db;
  let cleanup;
  let app;
  let newsletterService;
  let customerId;

  const MOUNT = '/api/public/newsletter';
  const get = (token) => request(app).get(`${MOUNT}/unsubscribe/${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    newsletterService = require('../../src/services/newsletterService');
    app = buildRouteApp(MOUNT, require('../../src/routes/publicNewsletter'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('customer_accounts').del();
    const [id] = await db('customer_accounts').insert({
      email: 'sub@example.com', is_active: 1, marketing_opt_out: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    customerId = typeof id === 'object' ? id.id : id;
  });

  it('opts the customer out and stamps the timestamp', async () => {
    const res = await get(newsletterService.unsubscribeToken(customerId));

    expect(res.status).toBe(200);
    const row = await db('customer_accounts').where({ id: customerId }).first();
    expect(row.marketing_opt_out).toBeTruthy();
    expect(row.marketing_opt_out_at).toBeTruthy();
  });

  it('needs no authentication', async () => {
    // No cookie, no header, no session — a mail client on any device.
    expect((await get(newsletterService.unsubscribeToken(customerId))).status).toBe(200);
  });

  it('is idempotent — clicking twice is not an error', async () => {
    const token = newsletterService.unsubscribeToken(customerId);
    const first = await get(token);
    const second = await get(token);

    expect(second.status).toBe(first.status);
    expect(second.text).toBe(first.text);
  });

  it('answers identically for a valid token, a forged one and an unknown id', async () => {
    const valid = await get(newsletterService.unsubscribeToken(customerId));
    const forged = await get('dGFtcGVyZWQtdG9rZW4');
    const unknown = await get(newsletterService.unsubscribeToken(987654));

    for (const res of [forged, unknown]) {
      expect(res.status).toBe(valid.status);
      expect(res.text).toBe(valid.text);
      expect(res.headers['content-type']).toBe(valid.headers['content-type']);
    }
  });

  it('leaves other customers untouched when the token is forged', async () => {
    await get('bm90LWEtcmVhbC10b2tlbg');
    const row = await db('customer_accounts').where({ id: customerId }).first();
    expect(row.marketing_opt_out).toBeFalsy();
  });

  it('rejects an id spliced onto another id\'s signature', async () => {
    const token = newsletterService.unsubscribeToken(customerId);
    const sig = Buffer.from(token, 'base64url').toString('utf8').split('.')[1];
    const forged = Buffer.from(`${customerId + 1}.${sig}`, 'utf8').toString('base64url');

    await get(forged);

    // Neither the target nor the spliced neighbour is changed.
    expect((await db('customer_accounts').where({ id: customerId }).first()).marketing_opt_out)
      .toBeFalsy();
  });

  it('renders a script-free confirmation page', async () => {
    const res = await get(newsletterService.unsubscribeToken(customerId));

    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.text).not.toContain('<script');
    // Self-contained: no external asset can make this page fail to render.
    expect(res.text).not.toMatch(/<(?:link|img|iframe)\b/);
  });

  it('tells the reader transactional mail is unaffected', async () => {
    const res = await get(newsletterService.unsubscribeToken(customerId));
    expect(res.text).toMatch(/transactional/i);
  });

  it('is not indexable', async () => {
    const res = await get(newsletterService.unsubscribeToken(customerId));
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('writes an activity log entry sourced to the link', async () => {
    await get(newsletterService.unsubscribeToken(customerId));

    const log = await db('activity_logs')
      .where({ activity_type: 'customer_marketing_opt_out' }).orderBy('id', 'desc').first();
    expect(log).toBeTruthy();
    expect(JSON.parse(log.metadata)).toMatchObject({ source: 'link', optOut: true });
  });
});
