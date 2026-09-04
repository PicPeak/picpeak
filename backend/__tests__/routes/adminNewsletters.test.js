/**
 * HTTP contract for the newsletter admin surface (#1264).
 *
 * Three gates stack on every route, and the ORDER matters: auth, then the
 * feature flag, then the permission. With the feature off the answer must be
 * "disabled", not "forbidden" — otherwise an install that never enabled
 * newsletters leaks the fact that the endpoint exists and is permission-gated.
 *
 * `newsletters.send` is deliberately separate from `newsletters.view`: mass
 * mail is the one action here that cannot be taken back.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-newsletters-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'newsletter-route-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

describe('admin newsletters routes', () => {
  let db;
  let cleanup;
  let app;
  let adminId;
  let superToken;
  let viewerToken;

  const MOUNT = '/api/admin/newsletters';
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  async function setFlag(on) {
    await db('feature_flags')
      .insert({ key: 'newsletters', value: on ? 1 : 0 })
      .onConflict('key')
      .merge();
    // requireFeatureFlag memoises for 10 s — clear it so the test sees the flip.
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    superToken = mintAdminToken(adminId);

    // A second admin holding newsletters.view but NOT newsletters.send.
    const [viewerId] = await db('admin_users').insert({
      username: 'viewer', email: 'viewer@example.com',
      password_hash: 'x', is_active: 1, created_at: new Date().toISOString(),
    }).returning('id');
    const viewerAdminId = typeof viewerId === 'object' ? viewerId.id : viewerId;
    const [roleId] = await db('roles').insert({
      name: 'newsletter_viewer', display_name: 'Newsletter Viewer',
      is_system: 0, priority: 10,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    const viewerRoleId = typeof roleId === 'object' ? roleId.id : roleId;
    const viewPerm = await db('permissions').where({ name: 'newsletters.view' }).first();
    await db('role_permissions').insert({ role_id: viewerRoleId, permission_id: viewPerm.id });
    await db('admin_users').where({ id: viewerAdminId }).update({ role_id: viewerRoleId });
    viewerToken = mintAdminToken(viewerAdminId);

    app = buildRouteApp(MOUNT, require('../../src/routes/adminNewsletters'));
    await setFlag(true);
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('email_campaign_recipients').del();
    await db('email_queue').del();
    await db('email_campaigns').del();
    await db('customer_accounts').del();
    await setFlag(true);
  });

  const createDraft = (over = {}) => request(app)
    .post(MOUNT).set(auth(superToken))
    .send({ name: 'Spring', subject: 'Spring offers', bodyHtml: '<p>Hi {{first_name}}</p>', ...over });

  // ---- gates -------------------------------------------------------------

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(MOUNT)).status).toBe(401);
  });

  it('refuses every route while the feature flag is off', async () => {
    await setFlag(false);
    const res = await request(app).get(MOUNT).set(auth(superToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NEWSLETTERS_DISABLED');
  });

  it('answers "disabled", not "forbidden", when the flag is off', async () => {
    // A super-admin holds every permission, so a 403 here can only come from
    // the flag — which is the gate that must win.
    await setFlag(false);
    expect((await request(app).get(MOUNT).set(auth(superToken))).body.code)
      .toBe('NEWSLETTERS_DISABLED');
  });

  it('lets newsletters.view read but not create', async () => {
    expect((await request(app).get(MOUNT).set(auth(viewerToken))).status).toBe(200);

    const res = await request(app).post(MOUNT).set(auth(viewerToken))
      .send({ name: 'x', subject: 'y' });
    expect(res.status).toBe(403);
  });

  it('refuses queue and cancel without newsletters.send', async () => {
    const { body } = await createDraft();
    const id = body.campaign.id;
    expect((await request(app).post(`${MOUNT}/${id}/queue`).set(auth(viewerToken))).status).toBe(403);
    expect((await request(app).post(`${MOUNT}/${id}/cancel`).set(auth(viewerToken))).status).toBe(403);
  });

  // ---- CRUD --------------------------------------------------------------

  it('creates a draft and sanitizes the body on write', async () => {
    const res = await createDraft({ bodyHtml: '<p>ok</p><script>alert(1)</script>' });

    expect(res.status).toBe(201);
    expect(res.body.campaign.status).toBe('draft');
    expect(res.body.campaign.bodyHtml).not.toContain('alert(1)');

    // And it is stored sanitized, not merely rendered so.
    const row = await db('email_campaigns').where({ id: res.body.campaign.id }).first();
    expect(row.body_html).not.toContain('alert(1)');
  });

  it('rejects a missing name or subject', async () => {
    expect((await request(app).post(MOUNT).set(auth(superToken)).send({ subject: 'x' })).status).toBe(400);
    expect((await request(app).post(MOUNT).set(auth(superToken)).send({ name: 'x' })).status).toBe(400);
  });

  it('rejects a subject carrying a newline (header injection)', async () => {
    const res = await createDraft({ subject: 'Hi\r\nBcc: evil@example.com' });
    expect(res.status).toBe(400);
  });

  it('rejects an over-long subject', async () => {
    expect((await createDraft({ subject: 'x'.repeat(256) })).status).toBe(400);
  });

  it('edits a draft', async () => {
    const { body } = await createDraft();
    const res = await request(app).put(`${MOUNT}/${body.campaign.id}`)
      .set(auth(superToken)).send({ subject: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.campaign.subject).toBe('Updated');
  });

  it('refuses to edit a campaign that is no longer a draft', async () => {
    await db('customer_accounts').insert({
      email: 'a@example.com', is_active: 1, marketing_opt_out: 0,
      created_at: new Date().toISOString(),
    });
    const { body } = await createDraft();
    const id = body.campaign.id;
    await request(app).post(`${MOUNT}/${id}/queue`).set(auth(superToken));

    const res = await request(app).put(`${MOUNT}/${id}`).set(auth(superToken)).send({ subject: 'x' });
    expect(res.status).toBe(409);
  });

  it('404s for an unknown campaign', async () => {
    expect((await request(app).get(`${MOUNT}/999999`).set(auth(superToken))).status).toBe(404);
  });

  // ---- state machine -----------------------------------------------------

  it('queues once and 409s on a second attempt', async () => {
    await db('customer_accounts').insert({
      email: 'a@example.com', is_active: 1, marketing_opt_out: 0,
      created_at: new Date().toISOString(),
    });
    const { body } = await createDraft();
    const id = body.campaign.id;

    expect((await request(app).post(`${MOUNT}/${id}/queue`).set(auth(superToken))).status).toBe(200);
    expect((await request(app).post(`${MOUNT}/${id}/queue`).set(auth(superToken))).status).toBe(409);
  });

  it('refuses to delete a queued campaign', async () => {
    await db('customer_accounts').insert({
      email: 'a@example.com', is_active: 1, marketing_opt_out: 0,
      created_at: new Date().toISOString(),
    });
    const { body } = await createDraft();
    const id = body.campaign.id;
    await request(app).post(`${MOUNT}/${id}/queue`).set(auth(superToken));

    expect((await request(app).delete(`${MOUNT}/${id}`).set(auth(superToken))).status).toBe(409);
  });

  it('deletes a draft', async () => {
    const { body } = await createDraft();
    expect((await request(app).delete(`${MOUNT}/${body.campaign.id}`).set(auth(superToken))).status)
      .toBe(200);
  });

  // ---- dry run + preview -------------------------------------------------

  it('reports recipient counts and opt-out skips without writing anything', async () => {
    await db('customer_accounts').insert([
      { email: 'a@example.com', is_active: 1, marketing_opt_out: 0, created_at: new Date().toISOString() },
      { email: 'b@example.com', is_active: 1, marketing_opt_out: 1, created_at: new Date().toISOString() },
    ]);
    const { body } = await createDraft();

    const res = await request(app)
      .post(`${MOUNT}/${body.campaign.id}/recipients/resolve`).set(auth(superToken));

    expect(res.status).toBe(200);
    expect(res.body.recipientCount).toBe(1);
    expect(res.body.skippedOptOut).toBe(1);
    expect(res.body.estimatedMinutes).toBe(1);
    // Dry run — nothing queued.
    expect(await db('email_queue').count({ c: '*' })).toEqual([{ c: 0 }]);
  });

  it('renders a preview with sample data', async () => {
    const { body } = await createDraft();
    const res = await request(app)
      .post(`${MOUNT}/${body.campaign.id}/preview`).set(auth(superToken)).send({});

    expect(res.status).toBe(200);
    expect(res.body.isSample).toBe(true);
    expect(res.body.html).toContain('Hi Alex');
  });

  it('renders a preview for a named customer', async () => {
    const [id] = await db('customer_accounts').insert({
      email: 'real@example.com', first_name: 'Robin', is_active: 1,
      marketing_opt_out: 0, created_at: new Date().toISOString(),
    }).returning('id');
    const customerId = typeof id === 'object' ? id.id : id;
    const { body } = await createDraft();

    const res = await request(app)
      .post(`${MOUNT}/${body.campaign.id}/preview`).set(auth(superToken))
      .send({ customerId });

    expect(res.body.isSample).toBe(false);
    expect(res.body.html).toContain('Hi Robin');
  });

  // ---- recipients listing ------------------------------------------------

  it('paginates the recipients list', async () => {
    await db('customer_accounts').insert(
      Array.from({ length: 5 }, (_, i) => ({
        email: `r${i}@example.com`, is_active: 1, marketing_opt_out: 0,
        created_at: new Date().toISOString(),
      }))
    );
    const { body } = await createDraft();
    const id = body.campaign.id;
    await request(app).post(`${MOUNT}/${id}/queue`).set(auth(superToken));

    const res = await request(app)
      .get(`${MOUNT}/${id}/recipients?page=1&limit=2`).set(auth(superToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
  });

  it('filters the recipients list by status', async () => {
    await db('customer_accounts').insert({
      email: 'a@example.com', is_active: 1, marketing_opt_out: 0,
      created_at: new Date().toISOString(),
    });
    const { body } = await createDraft();
    const id = body.campaign.id;
    await request(app).post(`${MOUNT}/${id}/queue`).set(auth(superToken));

    expect((await request(app).get(`${MOUNT}/${id}/recipients?status=queued`)
      .set(auth(superToken))).body.data).toHaveLength(1);
    expect((await request(app).get(`${MOUNT}/${id}/recipients?status=sent`)
      .set(auth(superToken))).body.data).toHaveLength(0);
  });

  // ---- list filter -------------------------------------------------------

  it('filters the campaign list by status', async () => {
    await createDraft({ name: 'One' });
    expect((await request(app).get(`${MOUNT}?status=draft`).set(auth(superToken)))
      .body.campaigns).toHaveLength(1);
    expect((await request(app).get(`${MOUNT}?status=sent`).set(auth(superToken)))
      .body.campaigns).toHaveLength(0);
  });

  it('rejects an unknown status filter', async () => {
    expect((await request(app).get(`${MOUNT}?status=bogus`).set(auth(superToken))).status).toBe(400);
  });
});
