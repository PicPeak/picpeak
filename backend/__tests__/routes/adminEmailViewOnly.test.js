/**
 * email.view is read-only, and it never sees a mailbox password.
 *
 * GET /config spread the whole email_configs row and masked only smtp_pass;
 * the row also carries the IMAP login since migration 128. The mailbox-state
 * route (archive / trash / restore) was open to email.view although it
 * rewrites the folders every admin sees.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mailview-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailview-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mailview-storage-'));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const SMTP_SECRET = 'smtp-real-secret';
const IMAP_SECRET = 'imap-real-secret';

describe('email.view — read-only and password-free', () => {
  let db; let cleanup; let app; let editorToken; let viewerToken; let receivedId; let queueId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const roleWith = async (name, permNames) => {
    const roleIns = await db('roles').insert({ name, display_name: name, priority: 10 }).returning('id');
    const roleId = roleIns[0]?.id ?? roleIns[0];
    const perms = await db('permissions').whereIn('name', permNames).select('id');
    await db('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission_id: p.id })));
    const userIns = await db('admin_users').insert({
      username: name, email: `${name}@example.com`, password_hash: 'x',
      must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
    }).returning('id');
    return mintAdminToken(userIns[0]?.id ?? userIns[0]);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');

    viewerToken = await roleWith('mail_reader', ['email.view']);
    editorToken = await roleWith('mail_editor', ['email.view', 'email.edit']);
    clearPermissionCache();

    await db('feature_flags').insert({ key: 'messaging', value: true }).onConflict('key').merge({ value: true });
    invalidateFeatureFlagCache();

    await db('email_configs').insert({
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_secure: false, smtp_user: 'mailer', smtp_pass: SMTP_SECRET,
      from_email: 'studio@example.com', from_name: 'Studio',
      imap_host: 'imap.example.com', imap_port: 993, imap_secure: true, imap_user: 'inbox@example.com',
      imap_pass: IMAP_SECRET, imap_folder: 'INBOX',
    });
    const r = await db('received_emails').insert({
      message_id: '<m1@example.com>', from_address: 'client@example.com', subject: 'Hello',
      received_at: new Date().toISOString(), status: 'ingested', mailbox_state: 'active',
    }).returning('id');
    receivedId = r[0]?.id ?? r[0];
    const q = await db('email_queue').insert({
      recipient_email: 'client@example.com', email_type: 'gallery_created', status: 'sent',
      mailbox_state: 'active', created_at: new Date().toISOString(),
    }).returning('id');
    queueId = q[0]?.id ?? q[0];

    app = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('GET /config masks the IMAP password like the SMTP one', async () => {
    const res = await auth(request(app).get('/api/admin/email/config'), viewerToken);
    expect(res.status).toBe(200);
    expect(res.body.smtp_pass).toBe('********');
    expect(res.body.imap_pass).toBe('********');
    expect(JSON.stringify(res.body)).not.toContain(SMTP_SECRET);
    expect(JSON.stringify(res.body)).not.toContain(IMAP_SECRET);
  });

  it('refuses email.view every mailbox-state transition', async () => {
    for (const [kind, id] of [['received', receivedId], ['queue', queueId]]) {
      for (const state of ['archived', 'deleted', 'active']) {
        const res = await auth(request(app).post(`/api/admin/email/item/${kind}/${id}/state`), viewerToken).send({ state });
        expect(res.status).toBe(403);
      }
    }
    expect((await db('received_emails').where({ id: receivedId }).first()).mailbox_state).toBe('active');
    expect((await db('email_queue').where({ id: queueId }).first()).mailbox_state).toBe('active');
  });

  it('lets email.edit archive, trash and restore both kinds', async () => {
    for (const [kind, table, id] of [['received', 'received_emails', receivedId], ['queue', 'email_queue', queueId]]) {
      for (const state of ['archived', 'deleted', 'active']) {
        const res = await auth(request(app).post(`/api/admin/email/item/${kind}/${id}/state`), editorToken).send({ state });
        expect(res.status).toBe(200);
        expect((await db(table).where({ id }).first()).mailbox_state).toBe(state);
      }
    }
  });
});
