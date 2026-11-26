/**
 * Mail recipients are customer addresses, so they are customers.view data.
 *
 * The project overview already blanks them for an admin without that
 * permission. The project email preview, the global email log (list, search
 * and reading pane) and the notification bell returned them in full, and the
 * log's search matched on the address, which answers "did we ever mail this
 * address?" without showing it. For such an admin recipients come back as
 * null and address-shaped text inside free text as `…`; a Super Admin and a
 * role holding customers.view keep everything.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mail-redact-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mail-redact-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mail-redact-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const ADDRESS = 'anna@kunde.example';

describe('admin mail surfaces — recipients need customers.view', () => {
  let db; let cleanup;
  let projectsApp; let emailApp; let notificationsApp;
  let superTok; let readerTok; let customerReaderTok;
  let mailId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const adminWithPermissions = async (name, permissions) => {
    const roleId = await insertId('roles', { name, display_name: name });
    for (const perm of await db('permissions').whereIn('name', permissions)) {
      await db('role_permissions').insert({ role_id: roleId, permission_id: perm.id });
    }
    const adminId = await insertId('admin_users', {
      username: name, email: `${name}@studio.example`, password_hash: 'x',
      must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
    });
    return mintAdminToken(adminId);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const perms = ['events.view', 'email.view', 'notifications.view'];
    readerTok = await adminWithPermissions('mail-reader', perms);
    customerReaderTok = await adminWithPermissions('mail-customer-reader', [...perms, 'customers.view']);
    clearPermissionCache();

    for (const key of ['projects', 'messaging']) {
      await db('feature_flags').insert({ key, value: 1 }).onConflict('key').merge({ value: 1 });
    }

    // An ownerless gallery: every role reaches its mail and its activity.
    const eventId = await insertId('events', {
      slug: 'redact-gallery', share_link: 'redact-gallery', event_type: 'wedding', event_name: 'Redact', event_date: '2027-01-10',
      customer_email: ADDRESS, admin_email: 'admin@example.com',
      password_hash: 'x', expires_at: '2028-01-01T00:00:00.000Z', created_by: null,
      created_at: new Date().toISOString(),
    });
    mailId = await insertId('email_queue', {
      recipient_email: ADDRESS, email_type: 'gallery_created', status: 'failed',
      email_data: JSON.stringify({ cc: ['cc@kunde.example'] }), event_id: eventId,
      rendered_html: '<p>Hello</p>',
      error_message: `550 5.1.1 <${ADDRESS}>: mailbox unavailable`,
      created_at: new Date().toISOString(),
    });
    await insertId('activity_logs', {
      activity_type: 'customer_login', actor_type: 'customer', actor_name: ADDRESS,
      metadata: JSON.stringify({ email: ADDRESS, nested: { to: [`Anna <${ADDRESS}>`] }, count: 2 }),
      event_id: eventId, created_at: new Date().toISOString(),
    });

    projectsApp = buildRouteApp('/api/admin/projects', require('../../src/routes/adminProjects'));
    emailApp = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
    notificationsApp = buildRouteApp('/api/admin/notifications', require('../../src/routes/adminNotifications'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const preview = (tok) => auth(request(projectsApp).get(`/api/admin/projects/email/${mailId}/preview`), tok);
  const queue = (tok, q = '') => auth(request(emailApp).get('/api/admin/email/queue').query(q ? { q } : {}), tok);
  const queueItem = (tok) => auth(request(emailApp).get(`/api/admin/email/queue/${mailId}`), tok);
  const bell = (tok) => auth(request(notificationsApp).get('/api/admin/notifications'), tok);

  it('blanks the recipient of the project email preview', async () => {
    const res = await preview(readerTok);
    expect(res.status).toBe(200);
    expect(res.body.recipient).toBeNull();
    expect(res.body.html).toContain('Hello');

    for (const tok of [superTok, customerReaderTok]) {
      expect((await preview(tok)).body.recipient).toBe(ADDRESS);
    }
  });

  it('blanks recipients and addresses in errors in the email log list', async () => {
    const res = await queue(readerTok);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i) => i.id === mailId);
    expect(row.recipientEmail).toBeNull();
    expect(row.errorMessage).toBe('550 5.1.1 <…>: mailbox unavailable');
    expect(JSON.stringify(res.body)).not.toContain(ADDRESS);

    for (const tok of [superTok, customerReaderTok]) {
      const full = (await queue(tok)).body.items.find((i) => i.id === mailId);
      expect(full.recipientEmail).toBe(ADDRESS);
      expect(full.errorMessage).toContain(ADDRESS);
    }
  });

  it('does not search the email log by recipient address without customers.view', async () => {
    expect((await queue(readerTok, 'anna@kunde')).body.items).toHaveLength(0);
    // The other column still matches.
    expect((await queue(readerTok, 'gallery_created')).body.items.map((i) => i.id)).toContain(mailId);

    for (const tok of [superTok, customerReaderTok]) {
      expect((await queue(tok, 'anna@kunde')).body.items.map((i) => i.id)).toContain(mailId);
    }
  });

  it('blanks recipient, cc and addresses in errors in the email log reading pane', async () => {
    const res = await queueItem(readerTok);
    expect(res.status).toBe(200);
    expect(res.body.recipientEmail).toBeNull();
    expect(res.body.cc).toBeNull();
    expect(res.body.errorMessage).toBe('550 5.1.1 <…>: mailbox unavailable');
    expect(JSON.stringify(res.body)).not.toContain('kunde.example');

    for (const tok of [superTok, customerReaderTok]) {
      const full = (await queueItem(tok)).body;
      expect(full.recipientEmail).toBe(ADDRESS);
      expect(full.cc).toBe('cc@kunde.example');
    }
  });

  it('removes addresses from notification metadata and actor names', async () => {
    const res = await bell(readerTok);
    expect(res.status).toBe(200);
    const n = res.body.notifications.find((x) => x.type === 'customer_login');
    expect(n).toBeDefined();
    expect(n.actorName).toBe('…');
    expect(n.metadata).toEqual({ email: '…', nested: { to: ['Anna <…>'] }, count: 2 });
    expect(JSON.stringify(res.body)).not.toContain(ADDRESS);

    for (const tok of [superTok, customerReaderTok]) {
      const full = (await bell(tok)).body.notifications.find((x) => x.type === 'customer_login');
      expect(full.actorName).toBe(ADDRESS);
      expect(full.metadata.email).toBe(ADDRESS);
    }
  });
});
