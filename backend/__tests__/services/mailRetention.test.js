const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mail-retention-')), 'db.sqlite');
process.env.SKIP_S3_TESTS = 'true';
process.env.EMAIL_INTAKE_MAX_ATTACHMENTS = '2';
process.env.JWT_SECRET = 'owned-mail-retention-tests-at-least-32-characters';

let mockMessages = [];
const mockDownloads = [];
jest.mock('imapflow', () => ({ ImapFlow: class {
  constructor(cfg) { this.user = cfg.auth.user; this.mailbox = { uidValidity: 17 }; }
  async connect() {} async logout() {} async close() {}
  async getMailboxLock() { return { release() {} }; }
  async search() { return mockMessages.filter(m => !m.user || m.user === this.user).map(m => m.uid); }
  async *fetch() {
    for (const m of mockMessages.filter(m => !m.user || m.user === this.user)) yield { uid: m.uid, size: m.size ?? m.source.length, envelope: { messageId: m.envelopeId ?? m.id, from: [{ address: m.sender || 'supplier@example.com' }] } };
  }
  async fetchOne(uid) { mockDownloads.push(`${this.user}:${uid}`); return { source: mockMessages.find(m => String(m.uid) === String(uid) && (!m.user || m.user === this.user)).source }; }
  async messageFlagsAdd() {}
} }));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
jest.setTimeout(120000);
let db, cleanup, tmpDir, adminId, customerId, mail, intake, expense, image;
let seq = 0;
function message({ id = `<mail-${++seq}@supplier.example>`, uid = ++seq, text = 'Ordinary supplier invoice', attachment = image, user, ...extra } = {}) {
  const source = Buffer.from(`${id ? `Message-ID: ${id}\r\n` : ''}From: Supplier <supplier@example.com>\r\nTo: intake@example.com\r\nSubject: supplier invoice\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n${attachment ? `--x\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=scan.png\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.toString('base64')}\r\n` : ''}--x--\r\n`);
  return { id, uid, source, user, ...extra };
}
const claim = (accountKey = 'accounting', bytes = 100000, sender = 'supplier@example.com') => mail.admit({ messageId: `<claim-${++seq}@example.com>`, accountKey, sender, bytes });
const usage = account => mail._internal.locked(trx => mail._internal.usage(trx, account));
async function capture(bytes = image) {
  const admitted = await claim();
  const filePath = await mail.saveAttachment({ content: bytes }, admitted);
  const doc = await expense.recordInboundDocument({ source: 'email', filePath, originalFilename: 'scan.png', mimeType: 'image/png', mailClaim: admitted }, null);
  await mail.finish(admitted, { status: 'ingested', body_text: 'Invoice body', inbound_document_id: doc.id });
  return { admitted, doc, filePath };
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  require('../../src/database/db').logActivity = async () => {};
  ({ adminId, customerId } = await seedMinimal(db));
  image = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).png().toBuffer();
  mail = require('../../src/services/mailRetentionService');
  expense = require('../../src/services/expenseService');
  intake = require('../../src/services/emailIntakeService');
  await db('feature_flags').insert({ key: 'incomingMail', value: 1 }).onConflict('key').merge({ value: 1 });
  const cfg = { imap_host: 'imap.example.com', imap_user: 'intake@example.com', imap_pass: 'fixture', imap_folder: 'INBOX' };
  const existing = await db('email_configs').first();
  if (existing) await db('email_configs').where({ id: existing.id }).update(cfg);
  else await db('email_configs').insert({ smtp_host: 'smtp.example.com', smtp_port: 587, from_email: 'intake@example.com', ...cfg });
});
beforeEach(async () => {
  for (const key of Object.keys(process.env).filter(k => k.startsWith('EMAIL_INTAKE_') && k !== 'EMAIL_INTAKE_MAX_ATTACHMENTS')) delete process.env[key];
  mockMessages = []; mockDownloads.length = 0;
  await db('expenses').del();
  await db('received_emails').del();
  await db('inbound_documents').del();
  await db('mail_intake_files').del();
  await db('mail_intake_state').del();
  await db('mail_intake_state').insert({ key: 'installation' });
  await db('mail_accounts').del();
  await fs.promises.rm(path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound'), { recursive: true, force: true });
});
afterAll(async () => { if (cleanup) await cleanup(); });

test('real parsed supplier mail retains bodies and byte-identical evidence but only one physical hash file', async () => {
  mockMessages = [message(), message()];
  expect(await intake.pollOnce()).toEqual({ processed: 2 });
  expect(mockDownloads).toHaveLength(2);
  const emails = await db('received_emails');
  expect(emails.every(e => e.body_text.includes('Ordinary supplier invoice'))).toBe(true);
  const docs = await db('inbound_documents').orderBy('id');
  expect(docs.map(d => d.status)).toEqual(['unsorted', 'duplicate']);
  expect(docs[1].duplicate_of_id).toBe(docs[0].id);
  expect(new Set(docs.map(d => d.file_path)).size).toBe(1);
  const files = await db('mail_intake_files');
  expect(files).toHaveLength(1);
  expect(await fs.promises.readFile(require('../../src/utils/storedPath').resolveStoredPath(files[0].file_path))).toEqual(image);
  expect(await fs.promises.readdir(path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound', 'mail'))).toHaveLength(1);
  const downloads = mockDownloads.length;
  await intake.pollOnce();
  expect(mockDownloads).toHaveLength(downloads);
});

test('capacity stops source downloads and retains only finite bounded metadata', async () => {
  process.env.EMAIL_INTAKE_MAILBOX_BYTES = '50000';
  process.env.EMAIL_INTAKE_INSTALLATION_BYTES = '50000';
  process.env.EMAIL_INTAKE_INSTALLATION_ROWS = '2';
  mockMessages = Array.from({ length: 20 }, () => message({ text: 'body'.repeat(1000) }));
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  expect(mockDownloads).toHaveLength(0);
  const rows = await db('received_emails');
  expect(rows).toHaveLength(2);
  expect(rows.every(r => r.body_text === null && r.body_html === null && r.status === 'error')).toBe(true);
  expect((await usage()).bytes).toBeLessThanOrEqual(50000);
  expect((await db('mail_intake_state').where({ key: 'installation' }).first()).blocked_count).toBe(20);
});

test('concurrent claims cannot oversubscribe installation or per-mailbox budgets', async () => {
  process.env.EMAIL_INTAKE_INSTALLATION_BYTES = '170000';
  process.env.EMAIL_INTAKE_MAILBOX_BYTES = '120000';
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(i % 2 ? 'customers' : 'accounting', 100000)));
  expect(results.filter(r => !r.skip)).toHaveLength(1);
  expect((await usage()).bytes).toBeLessThanOrEqual(170000);
  expect((await usage('accounting')).bytes).toBeLessThanOrEqual(120000);
  expect((await usage('customers')).bytes).toBeLessThanOrEqual(120000);
});

test('mailbox capacity is isolated while installation rate defeats sender rotation', async () => {
  process.env.EMAIL_INTAKE_MAILBOX_BYTES = '120000';
  expect((await claim('accounting')).skip).toBeUndefined();
  expect((await claim('accounting')).reason).toMatch(/capacity/);
  expect((await claim('customers')).skip).toBeUndefined();
  process.env.EMAIL_INTAKE_INSTALLATION_PER_HOUR = '3';
  expect((await claim('new-mailbox', 20000, 'rotated@example.net')).reason).toMatch(/rate/);
});

test('sender rate applies before download and expires in a persisted window', async () => {
  process.env.EMAIL_INTAKE_SENDER_PER_HOUR = '1';
  mockMessages = [message({ attachment: null }), message({ attachment: null })];
  expect(await intake.pollOnce()).toEqual({ processed: 1 });
  expect(mockDownloads).toHaveLength(1);
  expect((await db('received_emails').where({ status: 'error' }).first()).error).toMatch(/rate/);
  const states = await db('mail_intake_state').where('key', 'like', 'rate:sender:%');
  expect(states).toHaveLength(1);
  await db('mail_intake_state').where({ key: states[0].key }).update({ window_start: new Date(Date.now() - 2 * 3600000).toISOString() });
  expect((await claim('accounting', 20000)).skip).toBeUndefined();
});

test('mailbox/UID validity scopes no-Message-ID dedup; body-only mailbox remains supported', async () => {
  await db('mail_accounts').insert({ account_key: 'customers', enabled: 1, imap_host: 'imap.example.com', imap_user: 'customerbox@example.com', imap_pass: 'fixture' });
  mockMessages = [message({ id: null, uid: 1, user: 'intake@example.com', attachment: null }), message({ id: null, uid: 1, user: 'customerbox@example.com', attachment: null })];
  expect(await intake.pollOnce()).toEqual({ processed: 2 });
  expect(await db('received_emails').count({ n: '*' }).first()).toMatchObject({ n: 2 });
  expect((await db('received_emails').where({ account_key: 'customers' }).first()).status).toBe('received');
});

test('parsed/header aliases converge on one claim, and underreported decoded size fails before file persistence', async () => {
  const id = '<same-parser-id@example.com>';
  mockMessages = [message({ id }), message({ id, envelopeId: '<different-envelope@example.com>' })];
  expect(await intake.pollOnce()).toEqual({ processed: 1 });
  expect(await db('received_emails').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  mockMessages = [message({ size: 1, text: 'huge body '.repeat(10000) })];
  await intake.pollOnce();
  const error = await db('received_emails').where({ status: 'error' }).first();
  expect(error.error).toMatch(/reservation/);
  expect(error.body_text).toBeNull();
  expect(await db('mail_intake_files').count({ n: '*' }).first()).toMatchObject({ n: 1 });
});

test('expired and superseded crash claims cannot save files, records or bodies', async () => {
  const held = await claim();
  await mail.sweep({ now: new Date(Date.now() + mail.CLAIM_MS + 1) });
  await expect(mail.saveAttachment({ content: image }, held)).rejects.toThrow(/expired|superseded/);
  await expect(mail.recordDocument(held, async () => 'bad')).rejects.toThrow(/expired|superseded/);
  await expect(mail.finish(held, { status: 'received', body_text: 'bad' })).rejects.toThrow(/expired|superseded/);
  const next = await claim();
  await db('received_emails').where({ id: next.id }).update({ claim_token: crypto.randomUUID() });
  await expect(mail.saveAttachment({ content: image }, next)).rejects.toThrow(/superseded/);
  expect(await db('mail_intake_files')).toHaveLength(0);
});

test('a write failure leaves a charged tracked reservation, then sweeps without touching unowned files', async () => {
  const held = await claim();
  const original = fs.promises.writeFile;
  const spy = jest.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes('/inbound/mail/')) throw Object.assign(new Error('owned disk full'), { code: 'ENOSPC' });
    return original(...args);
  });
  await expect(mail.saveAttachment({ content: image }, held)).rejects.toThrow(/disk full/);
  spy.mockRestore();
  const files = await db('mail_intake_files');
  expect(files).toHaveLength(1);
  expect(Number(files[0].byte_size)).toBe(image.length);
  expect((await usage()).bytes).toBe(100000);
  await mail.sweep();
  expect(await db('mail_intake_files')).toHaveLength(1);
  const canary = path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound', 'mail', 'not-owned.txt');
  await fs.promises.writeFile(canary, 'keep');
  await mail.sweep({ now: new Date(Date.now() + mail.CLAIM_MS + 1) });
  await mail.sweep({ now: new Date(Date.now() + mail.CLAIM_MS + 1) });
  expect(await db('mail_intake_files')).toHaveLength(0);
  expect(await fs.promises.readFile(canary, 'utf8')).toBe('keep');
});

test('retention removes disposable duplicate captures and unreferenced owned files, not append-only audit charges', async () => {
  await capture(); await capture();
  const future = new Date(Date.now() + 91 * 86400000);
  for (let i = 0; i < 6; i++) await mail.sweep({ now: future });
  expect(await db('received_emails')).toHaveLength(0);
  expect(await db('inbound_documents')).toHaveLength(0);
  expect(await db('mail_intake_files')).toHaveLength(0);
  expect(await fs.promises.readdir(path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound', 'mail'))).toHaveLength(0);
  expect((await usage()).bytes).toBe(2 * mail.AUDIT_BYTES);
  expect((await db('accounting_change_history').where({ source: 'inbound.retention' })).length).toBeGreaterThanOrEqual(2);
});

test('curated/rebilled and linked proofs survive received retention and remain charged', async () => {
  const curated = await capture();
  await expense.updateInbound(curated.doc.id, { supplierName: 'Supplier', totalAmountMinor: 10000 }, adminId);
  await db('customer_accounts').where({ id: customerId }).update({ billing_cadence: 'monthly' });
  const billed = await expense.categorizeInbound(curated.doc.id, { disposition: 'rebill', customerAccountId: customerId }, adminId);
  expect(billed.billedInvoiceId).toBeTruthy();
  const linked = await capture(Buffer.from('different supplier image'));
  await db('expenses').insert({ inbound_document_id: linked.doc.id, disposition: 'eigener_aufwand', tax_treatment: 'domestic', status: 'open' });
  const future = new Date(Date.now() + 91 * 86400000);
  for (let i = 0; i < 4; i++) await mail.sweep({ now: future });
  expect(await db('received_emails')).toHaveLength(0);
  expect(await db('inbound_documents')).toHaveLength(2);
  expect(await db('mail_intake_files')).toHaveLength(2);
  expect(await fs.promises.readFile(curated.filePath)).toEqual(image);
  expect((await usage()).bytes).toBeGreaterThan(2 * mail.AUDIT_BYTES);
});

test('legacy backfill is idempotent and blocks unmeasured files until strict measurement', async () => {
  const captured = await capture();
  await db('mail_intake_files').del();
  await db('received_emails').where({ id: captured.admitted.id }).update({ retained_bytes: 0 });
  const migration = require('../../migrations/core/270_incoming_mail_retention');
  await migration.up(db); await migration.up(db);
  const file = await db('mail_intake_files').first();
  expect(Number(file.byte_size)).toBe(2 ** 42);
  expect((await claim()).skip).toBe(true);
  await mail.sweep();
  expect(Number((await db('mail_intake_files').first()).byte_size)).toBe(image.length);
  expect((await claim()).skip).toBeUndefined();
});

test('legacy stale processing rows without leases are fenced and reduced to bounded metadata', async () => {
  await db('received_emails').insert({ message_id: '<legacy-crash@example.com>', account_key: 'accounting', status: 'processing', retained_bytes: 100000, created_at: new Date(Date.now() - 3600000).toISOString() });
  await mail.sweep();
  const row = await db('received_emails').where({ message_id: '<legacy-crash@example.com>' }).first();
  expect(row.status).toBe('error');
  expect(Number(row.retained_bytes)).toBe(mail.META_BYTES);
});

test('a later unsafe file cannot roll back expired document deletion after an earlier unlink', async () => {
  const captured = await capture();
  const poison = 'business-docs/inbound/mail/email-' + 'f'.repeat(64) + '.bin';
  const poisonPath = require('../../src/utils/storedPath').resolveStoredPath(poison);
  const canary = path.join(tmpDir, 'outside-inbound.txt');
  await fs.promises.writeFile(canary, 'do not remove');
  await fs.promises.symlink(canary, poisonPath);
  await db('mail_intake_files').insert({ file_path: poison, file_sha256: 'f'.repeat(64), account_key: 'accounting', byte_size: 1 });
  await expect(mail.sweep({ now: new Date(Date.now() + 91 * 86400000) })).rejects.toThrow(/outside/);
  const surviving = await db('inbound_documents').where({ id: captured.doc.id }).first();
  expect(!surviving || fs.existsSync(captured.filePath)).toBe(true);
  expect(await fs.promises.readFile(canary, 'utf8')).toBe('do not remove');
});

test('reuse protects an old unreferenced hash while the new claim inspects and records it', async () => {
  const old = await claim();
  const filePath = await mail.saveAttachment({ content: image }, old);
  await mail.fail(old, new Error('crashed before document creation'));
  await db('mail_intake_files').update({ created_at: new Date(Date.now() - 3600000).toISOString() });
  const current = await claim();
  expect(await mail.saveAttachment({ content: image }, current)).toBe(filePath);
  await mail.sweep();
  expect(await fs.promises.readFile(filePath)).toEqual(image);
  const doc = await expense.recordInboundDocument({ source: 'email', filePath, originalFilename: 'scan.png', mimeType: 'image/png', mailClaim: current }, null);
  expect(doc.status).toBe('unsorted');
});
