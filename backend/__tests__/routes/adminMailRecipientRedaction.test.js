/**
 * Mail recipients are customer addresses, so they are customers.view data.
 *
 * The project overview already blanks them for an admin without that
 * permission. The project email preview, the global email log (list, search
 * and reading pane), the notification bell, the dashboard activity feed and
 * System health's stuck and waiting mail returned them in full, and the
 * log's search matched on the address, which answers "did we ever mail this
 * address?" without showing it. The mail bodies quote the addresses the mail
 * carries (the recipient, cc, template variables such as customer_email);
 * those leave the body too, except the studio's own addresses (the support
 * address, an admin's) that a template also passes as a variable. For such an admin recipients come back as
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
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp, setFeatureFlags,
} = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const ADDRESS = 'anna@kunde.example';
const STUDIO_LINK = '<p><a href="mailto:hello@studio.example">hello@studio.example</a></p>';
// The gallery's admin_email is the seeded admin user's address (tester@example.com).
const ADMIN_LINE = '<p>Gallery admin Tester@Example.com</p>';

describe('admin mail surfaces — recipients need customers.view', () => {
  let db; let cleanup;
  let projectsApp; let emailApp; let notificationsApp; let dashboardApp; let healthApp;
  let superTok; let readerTok; let customerReaderTok;
  let mailId; let reRenderedId;

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

    const perms = ['events.view', 'email.view', 'notifications.view', 'analytics.view', 'system.view'];
    readerTok = await adminWithPermissions('mail-reader', perms);
    customerReaderTok = await adminWithPermissions('mail-customer-reader', [...perms, 'customers.view']);
    clearPermissionCache();

    await setFeatureFlags(db, { projects: 1, messaging: 1 });
    await db('app_settings').insert({
      setting_key: 'branding_support_email', setting_value: JSON.stringify('hello@studio.example'), setting_type: 'branding',
    });

    // An ownerless gallery: every role reaches its mail and its activity.
    const eventId = await insertId('events', {
      slug: 'redact-gallery', share_link: 'redact-gallery', event_type: 'wedding', event_name: 'Redact', event_date: '2027-01-10',
      customer_email: ADDRESS, admin_email: 'admin@example.com',
      password_hash: 'x', expires_at: '2028-01-01T00:00:00.000Z', created_by: null,
      created_at: new Date().toISOString(),
    });
    mailId = await insertId('email_queue', {
      recipient_email: ADDRESS, email_type: 'gallery_created', status: 'failed',
      email_data: JSON.stringify({
        cc: ['cc@kunde.example'], contact: '"anna meier"@kunde.example',
        support_email: 'hello@studio.example', admin_email: 'Tester@Example.com',
      }),
      event_id: eventId,
      rendered_html: `<p>Hello ANNA@KUNDE.EXAMPLE, copy cc@kunde.example, &quot;anna meier&quot;@kunde.example</p>${ADMIN_LINE}${STUDIO_LINK}`,
      error_message: `550 5.1.1 <${ADDRESS}>: mailbox unavailable`,
      created_at: new Date().toISOString(),
    });
    // Due an hour ago and never picked up: System health lists it as waiting.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await insertId('email_queue', {
      recipient_email: 'waiting@kunde.example', email_type: 'gallery_created', status: 'pending',
      email_data: '{}', event_id: eventId, retry_count: 0, created_at: anHourAgo, scheduled_at: anHourAgo,
    });
    // Sent before bodies were stored: the preview renders it again, from a
    // template that prints {{customer_email}} (quote accepted, to the studio).
    await require('../../src/services/crmEmailTemplates').ensureCrmEmailTemplatesSeeded(db);
    reRenderedId = await insertId('email_queue', {
      recipient_email: 'owner@studio.example', email_type: 'quote_accepted_admin', status: 'sent',
      email_data: JSON.stringify({ customer_email: 'bert@kunde.example', quote_number: 'Q-RED-2' }),
      event_id: eventId, created_at: new Date().toISOString(),
    });
    await insertId('activity_logs', {
      activity_type: 'customer_login', actor_type: 'customer', actor_name: ADDRESS,
      metadata: JSON.stringify({ email: ADDRESS, nested: { to: [`Anna <${ADDRESS}>`] }, count: 2 }),
      event_id: eventId, created_at: new Date().toISOString(),
    });

    projectsApp = buildRouteApp('/api/admin/projects', require('../../src/routes/adminProjects'));
    emailApp = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
    notificationsApp = buildRouteApp('/api/admin/notifications', require('../../src/routes/adminNotifications'));
    dashboardApp = buildRouteApp('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
    healthApp = buildRouteApp('/api/admin/system-health', require('../../src/routes/adminSystemHealth'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const preview = (tok, id = mailId) => auth(request(projectsApp).get(`/api/admin/projects/email/${id}/preview`), tok);
  const queue = (tok, q = '') => auth(request(emailApp).get('/api/admin/email/queue').query(q ? { q } : {}), tok);
  const queueItem = (tok) => auth(request(emailApp).get(`/api/admin/email/queue/${mailId}`), tok);
  const bell = (tok) => auth(request(notificationsApp).get('/api/admin/notifications'), tok);
  const activity = (tok) => auth(request(dashboardApp).get('/api/admin/dashboard/activity'), tok);
  const failures = (tok) => auth(request(healthApp).get('/api/admin/system-health/failures'), tok);

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

  it('removes addresses from the dashboard activity feed', async () => {
    const res = await activity(readerTok);
    expect(res.status).toBe(200);
    const a = res.body.find((x) => x.type === 'customer_login');
    expect(a).toBeDefined();
    expect(a.actorName).toBe('…');
    expect(a.metadata).toEqual({ email: '…', nested: { to: ['Anna <…>'] }, count: 2 });
    expect(JSON.stringify(res.body)).not.toContain(ADDRESS);

    for (const tok of [superTok, customerReaderTok]) {
      const full = (await activity(tok)).body.find((x) => x.type === 'customer_login');
      expect(full.actorName).toBe(ADDRESS);
      expect(full.metadata.email).toBe(ADDRESS);
    }
  });

  it('blanks recipients and addresses in errors in System health', async () => {
    const res = await failures(readerTok);
    expect(res.status).toBe(200);
    const stuck = res.body.stuckEmails.find((e) => e.id === mailId);
    expect(stuck.recipientEmail).toBeNull();
    expect(stuck.errorMessage).toBe('550 5.1.1 <…>: mailbox unavailable');
    expect(res.body.waitingEmails).toHaveLength(1);
    expect(res.body.waitingEmails[0].recipientEmail).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('kunde.example');

    for (const tok of [superTok, customerReaderTok]) {
      const full = (await failures(tok)).body;
      expect(full.stuckEmails.find((e) => e.id === mailId).recipientEmail).toBe(ADDRESS);
      expect(full.stuckEmails.find((e) => e.id === mailId).errorMessage).toContain(ADDRESS);
      expect(full.waitingEmails[0].recipientEmail).toBe('waiting@kunde.example');
    }
  });

  it('removes the addresses the mail carries from its stored body, but not the studio\'s own', async () => {
    const redacted = `<p>Hello …, copy …, …</p>${ADMIN_LINE}${STUDIO_LINK}`;
    expect((await preview(readerTok)).body.html).toBe(redacted);
    expect((await queueItem(readerTok)).body.renderedHtml).toBe(redacted);

    for (const tok of [superTok, customerReaderTok]) {
      expect((await preview(tok)).body.html).toContain('ANNA@KUNDE.EXAMPLE');
      expect((await queueItem(tok)).body.renderedHtml).toContain('cc@kunde.example');
    }
  });

  it('removes the addresses from a body the preview renders again', async () => {
    const res = await preview(readerTok, reRenderedId);
    expect(res.status).toBe(200);
    expect(res.body.exact).toBe(false);
    expect(res.body.html).toContain('Q-RED-2');
    expect(res.body.html).not.toContain('bert@kunde.example');

    for (const tok of [superTok, customerReaderTok]) {
      expect((await preview(tok, reRenderedId)).body.html).toContain('bert@kunde.example');
    }
  });
});
