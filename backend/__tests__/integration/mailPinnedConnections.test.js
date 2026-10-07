/** Exercise the real routes/services and policy at connection time. All DNS,
 * sockets and protocol clients are injected; no external mail is contacted. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const { EventEmitter } = require('events');

process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mail-pinned-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mail-pinned-test-secret-at-least-32-characters';

const mockSmtpOptions = [];
const mockImapOptions = [];
const mockAccepted = [];
function mockOpenSmtp(options) {
  return new Promise((resolve, reject) => options.getSocket(options, (error, result) => {
    if (error) reject(error);
    else { result.connection.destroy(); resolve(); }
  }));
}
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(options => {
    mockSmtpOptions.push(options);
    return {
      verify: async () => { await mockOpenSmtp(options); return true; },
      sendMail: async mail => { await mockOpenSmtp(options); mockAccepted.push({ host: options.host, mail }); return { messageId: 'owned-message', accepted: [mail.to] }; },
      close: () => {},
    };
  }),
}));
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn(options => {
    mockImapOptions.push(options);
    return {
      connect: () => new Promise((resolve, reject) => options.tls.lookup(options.host, { all: true }, error => error ? reject(error) : resolve())),
      list: async () => [{ path: 'INBOX', name: 'INBOX' }],
      status: async () => ({ messages: 1, unseen: 0 }),
      getMailboxLock: async () => ({ release() {} }),
      search: async query => query.subject ? [777] : [],
      messageDelete: async () => true,
      logout: async () => {}, close: () => {},
    };
  }),
}));
jest.mock('../../src/services/emailWebhookTransport', () => ({
  isEnabled: jest.fn(() => false),
  send: jest.fn(async () => ({ messageId: 'owned-webhook' })),
}));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
const record = address => ({ address, family: net.isIP(address) });
const publicRecords = [record('8.8.8.8')];
const privateRecords = [record('127.0.0.1')];

describe('mail entry points consume guarded connection answers', () => {
  let db; let cleanup; let app; let token; let processor; let intake; let lookup; let connect;
  const post = (url, body = {}) => request(app).post(`/api/admin/email${url}`).set('Authorization', `Bearer ${token}`).send(body);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin'); token = mintAdminToken(adminId);
    for (const key of ['messaging', 'incomingMail']) {
      await db('feature_flags').insert({ key, value: 1 }).onConflict('key').merge({ value: 1 });
    }
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    await db('email_configs').insert({
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_user: 'mailer', smtp_pass: 'fixture-only', smtp_secure: false,
      from_email: 'sender@example.com', from_name: 'Fixture',
      imap_host: 'imap.example.com', imap_port: 993, imap_secure: true, imap_user: 'inbox@example.com', imap_pass: 'fixture-only', imap_folder: 'INBOX',
    });
    await db('mail_accounts').insert({ account_key: 'customers', enabled: true,
      smtp_host: 'account-smtp.example.com', smtp_port: 587, smtp_user: 'reply@example.com', smtp_pass: 'fixture-only', smtp_secure: false,
      imap_host: 'account-imap.example.com', imap_port: 993, imap_user: 'reply@example.com', imap_pass: 'fixture-only', imap_secure: true,
    });
    processor = require('../../src/services/emailProcessor');
    intake = require('../../src/services/emailIntakeService');
    app = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
  }, 120000);
  beforeEach(() => {
    delete process.env.MAIL_PRIVATE_ENDPOINTS;
    mockSmtpOptions.length = 0; mockImapOptions.length = 0; mockAccepted.length = 0;
    lookup = jest.spyOn(dns, 'lookup').mockResolvedValue(publicRecords);
    connect = jest.spyOn(net, 'createConnection').mockImplementation(options => {
      const socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; };
      process.nextTick(() => options.lookup(options.host, { all: true }, (error, records) => {
        if (socket.destroyed) return;
        if (error) socket.emit('error', error);
        else { expect(records).toEqual(publicRecords); socket.emit('connect'); }
      }));
      return socket;
    });
    const webhook = require('../../src/services/emailWebhookTransport');
    webhook.isEnabled.mockReturnValue(false); webhook.send.mockClear();
  });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.MAIL_PRIVATE_ENDPOINTS; });
  afterAll(async () => { await processor?.stopEmailQueueProcessor(); if (cleanup) await cleanup(); });

  it('covers all four SMTP constructors and saved IMAP diagnostics with unchanged success contracts', async () => {
    const cached = await processor.initializeTransporter(true); expect(cached).toBeTruthy();
    expect((await processor.sendRawEmail({ to: 'target@example.com', subject: 'global', text: 'fixture' })).transport).toBe('smtp');
    await processor.sendRawEmail({ accountKey: 'customers', to: 'target@example.com', text: 'account' });
    expect((await post('/test', { test_email: 'target@example.com' })).status).toBe(200);
    expect((await post('/incoming-config/folders')).body.folders).toEqual([{ path: 'INBOX', name: 'INBOX', specialUse: null }]);
    expect((await post('/incoming-config/test')).body).toMatchObject({ ok: true, messages: 1 });
    expect((await post('/incoming-config/roundtrip')).body).toMatchObject({ ok: true, recipient: 'inbox@example.com' });
    expect(mockSmtpOptions).toHaveLength(4); expect(mockImapOptions).toHaveLength(3);
    for (const options of mockSmtpOptions) expect(options).toMatchObject({ getSocket: expect.any(Function), tls: { host: options.host, servername: options.host } });
    for (const options of mockImapOptions) expect(options.tls).toMatchObject({ host: options.host, servername: options.host, lookup: expect.any(Function) });
    expect(mockAccepted.map(({ host }) => host)).toEqual(['smtp.example.com', 'account-smtp.example.com', 'smtp.example.com', 'smtp.example.com']);
  });

  it('rejects fresh private answers on cached global sends and queue/template delivery, not only initialization', async () => {
    expect(await processor.initializeTransporter(true)).toBeTruthy();
    lookup.mockResolvedValue(privateRecords);
    await expect(processor.sendRawEmail({ to: 'target@example.com', text: 'must not send' })).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
    const template = await db('email_templates').first(); expect(template).toBeTruthy();
    await expect(processor.sendTemplateEmail('target@example.com', template.template_key, { __language: 'en' })).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
    const inserted = await db('email_queue').insert({ recipient_email: 'target@example.com', email_type: template.template_key, email_data: '{}', status: 'pending', retry_count: 0 }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    expect(await processor.processEmailQueue({ onlyId: id, ignoreSchedule: true })).toMatchObject({ sent: 0, failed: 1 });
    expect((await db('email_queue').where({ id }).first()).retry_count).toBe(1);
    expect(mockAccepted).toHaveLength(0);
  });

  it.each(['/incoming-config/folders', '/incoming-config/test', '/accounts/test'])
  ('rejects a changed answer between request preflight and the IMAP connector at %s', async url => {
    lookup.mockResolvedValueOnce(publicRecords).mockResolvedValueOnce(privateRecords);
    const response = await post(url, { imap_host: 'imap.example.com', imap_port: 993, imap_secure: true, imap_user: 'inbox@example.com', imap_pass: 'fixture-new' });
    expect(response.status).toBe(422); expect(response.body.code).toBe('MAIL_HOST_FORBIDDEN');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('guards saved diagnostics without caller overrides and round-trip sends without any route preflight', async () => {
    lookup.mockResolvedValue(privateRecords);
    expect((await post('/incoming-config/test')).body.code).toBe('MAIL_HOST_FORBIDDEN');
    expect((await post('/test', { test_email: 'target@example.com' })).body.code).toBe('MAIL_HOST_FORBIDDEN');
    const roundtrip = await post('/incoming-config/roundtrip');
    expect(roundtrip.status).toBe(400); expect(roundtrip.body).toMatchObject({ sent: false, code: 'MAIL_HOST_FORBIDDEN' });
    expect(mockAccepted).toHaveLength(0);
  });

  it('enforces the IMAP guard after a successful round-trip SMTP send', async () => {
    lookup.mockResolvedValueOnce(publicRecords).mockResolvedValueOnce(privateRecords);
    const response = await post('/incoming-config/roundtrip');
    expect(response.status).toBe(422); expect(response.body.code).toBe('MAIL_HOST_FORBIDDEN');
    expect(mockAccepted).toHaveLength(1);
  });

  it('continues to enabled extra mailboxes when the primary literal is refused before client construction', async () => {
    await db('email_configs').update({ imap_host: '127.0.0.1' });
    try {
      expect(await intake.pollOnce()).toEqual({ processed: 0 });
      expect(mockImapOptions.map(options => options.host)).toEqual(['account-imap.example.com']);
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally { await db('email_configs').update({ imap_host: 'imap.example.com' }); }
  });

  it('guards primary and extra mailbox pollers on every polling cycle', async () => {
    expect(await intake.pollOnce()).toEqual({ processed: 0 });
    lookup.mockResolvedValue(privateRecords);
    expect(await intake.pollOnce()).toEqual({ processed: 0 });
    expect(mockImapOptions.map(options => options.host)).toEqual(['imap.example.com', 'account-imap.example.com', 'imap.example.com', 'account-imap.example.com']);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('preserves global webhook delivery but still guards explicitly configured per-account SMTP', async () => {
    const webhook = require('../../src/services/emailWebhookTransport'); webhook.isEnabled.mockReturnValue(true);
    lookup.mockResolvedValue(privateRecords);
    expect((await processor.sendRawEmail({ to: 'target@example.com', text: 'webhook' })).transport).toBe('webhook');
    expect(webhook.send).toHaveBeenCalledTimes(1); expect(connect).not.toHaveBeenCalled();
    await expect(processor.sendRawEmail({ accountKey: 'customers', to: 'target@example.com', text: 'must not send' })).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
    expect(webhook.send).toHaveBeenCalledTimes(1); expect(mockAccepted).toHaveLength(0);
  });
});
