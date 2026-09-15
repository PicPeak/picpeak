/**
 * A stored mail password only goes to the server it was saved for.
 *
 * The SMTP and IMAP forms send the password back masked, and the server kept
 * the stored value whatever else changed. An admin could therefore point the
 * saved SMTP config at their own host and press "send test email", or run the
 * IMAP connection test / folder detection against their own host with a
 * masked password, and receive the real password. The IMAP tests were also
 * open to email.view.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mailtarget-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailtarget-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mailtarget-storage-'));

// No DNS in tests: every host counts as public.
jest.mock('../../src/utils/networkValidation', () => ({
  ...jest.requireActual('../../src/utils/networkValidation'),
  isHostAllowed: async () => true,
}));

// Record every IMAP login instead of connecting.
const mockImapLogins = [];
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation((opts) => {
    mockImapLogins.push({ host: opts.host, port: opts.port, user: opts.auth?.user, pass: opts.auth?.pass });
    return {
      connect: async () => {},
      list: async () => [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }],
      status: async () => ({ messages: 1, unseen: 0 }),
      logout: async () => {},
      close: () => {},
    };
  }),
}));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const SMTP_SECRET = 'smtp-real-secret';
const IMAP_SECRET = 'imap-real-secret';
const ACCOUNT_SECRET = 'account-real-secret';

describe('mail passwords stay with their saved server', () => {
  let db; let cleanup; let app; let token; let viewerToken;

  const post = (url, body, bearer = token) => request(app).post(`/api/admin/email${url}`)
    .set('Authorization', `Bearer ${bearer}`).send(body);
  const smtpForm = (overrides = {}) => ({
    smtp_host: 'smtp.example.com', smtp_port: 587, smtp_secure: false, smtp_user: 'mailer',
    smtp_pass: '********', from_email: 'studio@example.com', from_name: 'Studio', ...overrides,
  });
  const imapForm = (overrides = {}) => ({
    imap_host: 'imap.example.com', imap_port: 993, imap_secure: true, imap_user: 'inbox@example.com',
    imap_pass: '********', imap_folder: 'INBOX', ...overrides,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    // An admin who may only read email settings.
    const roleIns = await db('roles').insert({ name: 'mail_reader', display_name: 'Mail reader', priority: 10 }).returning('id');
    const roleId = roleIns[0]?.id ?? roleIns[0];
    const permId = (await db('permissions').where({ name: 'email.view' }).first()).id;
    await db('role_permissions').insert({ role_id: roleId, permission_id: permId });
    const viewerIns = await db('admin_users').insert({
      username: 'mail-reader', email: 'reader@example.com', password_hash: 'x',
      must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
    }).returning('id');
    viewerToken = mintAdminToken(viewerIns[0]?.id ?? viewerIns[0]);
    clearPermissionCache();

    await db('feature_flags').insert({ key: 'messaging', value: true }).onConflict('key').merge({ value: true });
    invalidateFeatureFlagCache();

    await db('email_configs').insert({
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_secure: false, smtp_user: 'mailer', smtp_pass: SMTP_SECRET,
      from_email: 'studio@example.com', from_name: 'Studio',
      imap_host: 'imap.example.com', imap_port: 993, imap_secure: true, imap_user: 'inbox@example.com',
      imap_pass: IMAP_SECRET, imap_folder: 'INBOX',
    });
    await db('mail_accounts').insert({
      account_key: 'customers', imap_host: 'imap.example.com', imap_port: 993, imap_secure: true,
      imap_user: 'hello@example.com', imap_pass: ACCOUNT_SECRET, imap_folder: 'INBOX',
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_secure: false, smtp_user: 'hello@example.com',
      smtp_pass: ACCOUNT_SECRET, enabled: true, created_at: new Date().toISOString(),
    });

    // Saving the SMTP config rebuilds the transporter; nothing to connect to here.
    const emailProcessor = require('../../src/services/emailProcessor');
    jest.spyOn(emailProcessor, 'initializeTransporter').mockResolvedValue(null);
    app = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(() => { mockImapLogins.length = 0; });

  describe('outgoing SMTP config', () => {
    it('refuses to keep the saved password for another server', async () => {
      for (const change of [{ smtp_host: 'mail.attacker.example' }, { smtp_port: 2525 }, { smtp_user: 'other' }, { smtp_secure: true }]) {
        const res = await post('/config', smtpForm(change));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PASSWORD_REQUIRED');
      }
      const row = await db('email_configs').first();
      expect(row.smtp_host).toBe('smtp.example.com');
      expect(row.smtp_pass).toBe(SMTP_SECRET);
    });

    it('keeps the saved password when only other fields change, and accepts a new server with a new password', async () => {
      const same = await post('/config', smtpForm({ from_name: 'Studio Renamed', smtp_host: 'SMTP.example.com' }));
      expect(same.status).toBe(200);
      expect((await db('email_configs').first()).smtp_pass).toBe(SMTP_SECRET);

      const moved = await post('/config', smtpForm({ smtp_host: 'smtp2.example.com', smtp_pass: 'new-secret' }));
      expect(moved.status).toBe(200);
      const row = await db('email_configs').first();
      expect(row.smtp_host).toBe('smtp2.example.com');
      expect(row.smtp_pass).toBe('new-secret');
      // restore for the following cases
      await db('email_configs').update({ smtp_host: 'smtp.example.com', smtp_pass: SMTP_SECRET, from_name: 'Studio' });
    });
  });

  describe('incoming IMAP config', () => {
    it('refuses to keep the saved password when the server changes on save', async () => {
      const res = await post('/incoming-config', imapForm({ imap_host: 'imap.attacker.example' }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSWORD_REQUIRED');
      expect((await db('email_configs').first()).imap_host).toBe('imap.example.com');
    });

    it('never logs in to a caller-chosen server with the saved password', async () => {
      for (const url of ['/incoming-config/test', '/incoming-config/folders']) {
        const res = await post(url, imapForm({ imap_host: 'imap.attacker.example' }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PASSWORD_REQUIRED');
      }
      expect(mockImapLogins).toEqual([]);
    });

    it('still tests the saved server with the masked password', async () => {
      const res = await post('/incoming-config/test', imapForm());
      expect(res.status).toBe(200);
      expect(mockImapLogins).toEqual([expect.objectContaining({ host: 'imap.example.com', pass: IMAP_SECRET })]);
    });

    it('requires email.edit to test or detect folders', async () => {
      for (const url of ['/incoming-config/test', '/incoming-config/folders', '/accounts/test']) {
        const res = await post(url, imapForm({ account_key: 'customers' }), viewerToken);
        expect(res.status).toBe(403);
      }
      expect(mockImapLogins).toEqual([]);
    });
  });

  describe('additional mailboxes', () => {
    const accountForm = (overrides = {}) => ({
      account_key: 'customers', imap_host: 'imap.example.com', imap_port: 993, imap_secure: true,
      imap_user: 'hello@example.com', imap_pass: '********', smtp_host: 'smtp.example.com', smtp_port: 587,
      smtp_secure: false, smtp_user: 'hello@example.com', smtp_pass: '********', enabled: true, ...overrides,
    });

    it('tests a mailbox with its saved password only on its saved server', async () => {
      const moved = await post('/accounts/test', accountForm({ imap_host: 'imap.attacker.example' }));
      expect(moved.status).toBe(400);
      expect(mockImapLogins).toEqual([]);

      const same = await post('/accounts/test', accountForm());
      expect(same.status).toBe(200);
      expect(mockImapLogins).toEqual([expect.objectContaining({ host: 'imap.example.com', pass: ACCOUNT_SECRET })]);
    });

    it('refuses to save a changed server with the kept password', async () => {
      const imap = await post('/accounts', accountForm({ imap_user: 'someone-else@example.com' }));
      expect(imap.status).toBe(400);
      const smtp = await post('/accounts', accountForm({ smtp_host: 'smtp.attacker.example' }));
      expect(smtp.status).toBe(400);
      const row = await db('mail_accounts').where({ account_key: 'customers' }).first();
      expect(row.imap_user).toBe('hello@example.com');
      expect(row.smtp_host).toBe('smtp.example.com');

      const unchanged = await post('/accounts', accountForm({ label: 'Hello box' }));
      expect(unchanged.status).toBe(200);
      expect((await db('mail_accounts').where({ account_key: 'customers' }).first()).imap_pass).toBe(ACCOUNT_SECRET);
    });
  });
});
