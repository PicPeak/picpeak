/**
 * Links that act as credentials must not be readable from the admin archive.
 *
 * Invitation and password-reset emails link to a token that sets the
 * account's password; the Messages reading pane (email.view) served those
 * links verbatim, so an admin could accept a pending super-admin invite.
 * Workflow approval and payment-check links act without a login too. And
 * webhook delivery payloads, readable with settings.view, carry the event's
 * gallery share link.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-recoverylinks-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'recoverylinks-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-recoverylinks-storage-'));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { MASK, redactBearerLinks, hasMaskedRecoveryLink } = require('../../src/utils/emailSecretRedaction');

const INVITE = 'b1'.repeat(32);
const CUSTOMER_INVITE = 'c2'.repeat(32);
const RESET = 'd3'.repeat(32);
const APPROVAL = 'e4'.repeat(32);
const PAYMENT = 'f5'.repeat(32);

function stubWebhookTransport() {
  const transport = require('../../src/services/emailWebhookTransport');
  const savedFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'noreply@example.com';
  const mails = [];
  const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
  const send = jest.spyOn(transport, 'send').mockImplementation(async (mail) => { mails.push(mail); return { messageId: `m-${mails.length}` }; });
  return {
    mails,
    restore() {
      enabled.mockRestore(); send.mockRestore();
      if (savedFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = savedFrom;
    },
  };
}

describe('redactBearerLinks', () => {
  it('masks invitation, reset, approval and payment-check tokens and keeps the rest', () => {
    const body = `<a href="https://photos.example.com/invite/${INVITE}">join</a>`
      + ` https://photos.example.com/customer/invite/${CUSTOMER_INVITE}`
      + ` https://photos.example.com/customer/reset-password/${RESET}`
      + ` https://photos.example.com/api/public/workflow-approvals/${APPROVAL}/confirm`
      + ` https://photos.example.com/payment-check/${PAYMENT}?action=paid_full`;
    const out = redactBearerLinks(body);
    for (const secret of [INVITE, CUSTOMER_INVITE, RESET, APPROVAL, PAYMENT]) expect(out).not.toContain(secret);
    expect(out).toContain(`/invite/${MASK}`);
    expect(out).toContain(`/workflow-approvals/${MASK}/confirm`);
    expect(out).toContain(`/payment-check/${MASK}?action=paid_full`);
    expect(out).toContain('join');
    expect(redactBearerLinks(`/gallery/${'a'.repeat(64)}`)).toBe(`/gallery/${'a'.repeat(64)}`);
  });
});

describe('admin archive of credential links', () => {
  let db; let cleanup; let token; let viewerToken; let integratorToken; let adminId;

  async function roleUser(name, permissions) {
    const roleIns = await db('roles').insert({ name, display_name: name, priority: 10 }).returning('id');
    const roleId = roleIns[0]?.id ?? roleIns[0];
    for (const perm of permissions) {
      const permRow = await db('permissions').where({ name: perm }).first();
      await db('role_permissions').insert({ role_id: roleId, permission_id: permRow.id });
    }
    const ins = await db('admin_users').insert({
      username: name, email: `${name}@example.com`, password_hash: 'x',
      must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
    }).returning('id');
    return mintAdminToken(ins[0]?.id ?? ins[0]);
  }

  const queueRow = (fields) => db('email_queue').insert({
    recipient_email: 'someone@example.com', status: 'sent', retry_count: 0,
    created_at: new Date().toISOString(), sent_at: new Date().toISOString(), ...fields,
  }).returning('id').then((r) => r[0]?.id ?? r[0]);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    viewerToken = await roleUser('settings_reader', ['settings.view']);
    integratorToken = await roleUser('integrator', ['settings.integrations']);
    clearPermissionCache();
    await db('feature_flags').insert({ key: 'messaging', value: true }).onConflict('key').merge({ value: true });
    invalidateFeatureFlagCache();
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('the Messages reading pane masks invitation, reset, approval and payment-check links', async () => {
    const app = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
    const id = await queueRow({
      email_type: 'admin_invitation',
      email_data: JSON.stringify({ invite_link: `https://photos.example.com/invite/${INVITE}` }),
      rendered_html: `<p><a href="https://photos.example.com/invite/${INVITE}">Accept</a></p>`
        + `<p>https://photos.example.com/customer/reset-password/${RESET}</p>`
        + `<p>https://photos.example.com/api/public/workflow-approvals/${APPROVAL}/deny</p>`
        + `<p>https://photos.example.com/payment-check/${PAYMENT}?action=unpaid</p>`,
    });

    const res = await request(app).get(`/api/admin/email/queue/${id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    for (const secret of [INVITE, RESET, APPROVAL, PAYMENT]) expect(body).not.toContain(secret);
    expect(res.body.renderedHtml).toContain(`/invite/${MASK}`);
  });

  it('the project email preview masks them too', async () => {
    const { getEmailPreview } = require('../../src/services/projectService');
    const id = await queueRow({
      email_type: 'customer_invitation',
      email_data: JSON.stringify({ invite_link: `https://photos.example.com/customer/invite/${CUSTOMER_INVITE}` }),
      rendered_html: `<a href="https://photos.example.com/customer/invite/${CUSTOMER_INVITE}">Join</a>`,
    });

    const preview = await getEmailPreview(id);

    expect(preview.html).not.toContain(CUSTOMER_INVITE);
    expect(preview.html).toContain(`/customer/invite/${MASK}`);
  });

  it('scrubs the invitation link once sent, and never sends that row again', async () => {
    const id = await queueRow({
      email_type: 'customer_password_reset', status: 'pending', sent_at: null,
      scheduled_at: new Date().toISOString(),
      email_data: JSON.stringify({ reset_link: `https://photos.example.com/customer/reset-password/${RESET}`, expires_at: new Date(Date.now() + 3600000).toISOString() }),
    });
    const { processEmailQueue } = require('../../src/services/emailProcessor');
    const stub = stubWebhookTransport();
    try {
      await processEmailQueue({ ignoreSchedule: true, onlyId: id });
    } finally { stub.restore(); }

    // the customer got the working link; the archive did not keep it
    expect(stub.mails).toHaveLength(1);
    expect(String(stub.mails[0].html)).toContain(RESET);
    const row = await db('email_queue').where({ id }).first();
    expect(row.status).toBe('sent');
    expect(row.email_data).not.toContain(RESET);
    expect(JSON.parse(row.email_data).reset_link).toContain(`/reset-password/${MASK}`);
    if (row.rendered_html) expect(row.rendered_html).not.toContain(RESET);
    expect(hasMaskedRecoveryLink(JSON.parse(row.email_data))).toBe(true);

    // resend, retry and send-now refuse instead of mailing a dead link
    const projectService = require('../../src/services/projectService');
    for (const action of ['resendEmail', 'retryEmail', 'sendEmailNow']) {
      await expect(projectService[action](id)).rejects.toMatchObject({ statusCode: 409 });
    }

    // any other requeue path (e.g. a raw status reset) is refused by the processor
    await db('email_queue').where({ id }).update({ status: 'pending', retry_count: 0 });
    const again = stubWebhookTransport();
    try {
      await processEmailQueue({ ignoreSchedule: true, onlyId: id });
    } finally { again.restore(); }
    expect(again.mails).toHaveLength(0);
    const refused = await db('email_queue').where({ id }).first();
    expect(refused.status).toBe('failed');
    expect(refused.error_message).toMatch(/cannot be sent again/);
  });

  it('webhook delivery detail hides share links from settings.view, not from settings.integrations', async () => {
    const app = buildRouteApp('/api/admin/webhooks', require('../../src/routes/adminWebhooks'));
    const hookIns = await db('webhooks').insert({
      name: 'CRM', url: 'https://hooks.example.com/in', secret: 'whsec', events: JSON.stringify(['event.created']),
      active: true, created_by: adminId, created_at: new Date().toISOString(),
    }).returning('id');
    const webhookId = hookIns[0]?.id ?? hookIns[0];
    const payload = {
      event_type: 'event.created',
      data: { event: { slug: 'wedding', share_token: 'sharetok123', share_url: 'https://photos.example.com/gallery/wedding/sharetok123', customer_email: 'client@example.com' } },
    };
    const delIns = await db('webhook_deliveries').insert({
      webhook_id: webhookId, event_type: 'event.created', payload: JSON.stringify(payload),
      status: 'success', attempt_count: 1, created_at: new Date().toISOString(),
    }).returning('id');
    const deliveryId = delIns[0]?.id ?? delIns[0];
    const url = `/api/admin/webhooks/${webhookId}/deliveries/${deliveryId}`;

    const viewer = await request(app).get(url).set('Authorization', `Bearer ${viewerToken}`);
    expect(viewer.status).toBe(200);
    expect(JSON.stringify(viewer.body)).not.toContain('sharetok123');
    expect(viewer.body.payload.data.event.slug).toBe('wedding');
    expect(viewer.body.payload.data.event.customer_email).toBe('client@example.com');

    const integrator = await request(app).get(url).set('Authorization', `Bearer ${integratorToken}`);
    expect(integrator.status).toBe(200);
    expect(integrator.body.payload.data.event.share_token).toBe('sharetok123');
  });
});
