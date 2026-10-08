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
const mockSeen = [];
jest.mock('imapflow', () => ({ ImapFlow: class {
  constructor(cfg) { this.user = cfg.auth.user; this.mailbox = { uidValidity: 17 }; }
  async connect() {} async logout() {} async close() {}
  async getMailboxLock() { return { release() {} }; }
  async search() { return mockMessages.filter(m => !m.user || m.user === this.user).map(m => m.uid); }
  async *fetch() {
    for (const m of mockMessages.filter(m => !m.user || m.user === this.user)) yield { uid: m.uid, size: m.size ?? m.source.length, envelope: { messageId: m.envelopeId ?? m.id, from: [{ address: m.sender || 'supplier@example.com' }] } };
  }
  async fetchOne(uid) { mockDownloads.push(`${this.user}:${uid}`); return { source: mockMessages.find(m => String(m.uid) === String(uid) && (!m.user || m.user === this.user)).source }; }
  async messageFlagsAdd(uid) { mockSeen.push(uid); }
} }));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
jest.setTimeout(120000);
let db, cleanup, tmpDir, adminId, customerId, mail, intake, expense, image, logger;
let seq = 0;
function message({ id = `<mail-${++seq}@supplier.example>`, uid = ++seq, text = 'Ordinary supplier invoice', attachment = image, user, ...extra } = {}) {
  const source = Buffer.from(`${id ? `Message-ID: ${id}\r\n` : ''}From: Supplier <supplier@example.com>\r\nTo: intake@example.com\r\nSubject: supplier invoice\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n${attachment ? `--x\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=scan.png\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.toString('base64')}\r\n` : ''}--x--\r\n`);
  return { id, uid, source, user, ...extra };
}
const claim = (accountKey = 'accounting', bytes = 100000, sender = 'supplier@example.com') => mail.admit({ messageId: `<claim-${++seq}@example.com>`, accountKey, sender, bytes });
const usage = account => mail._internal.locked(trx => mail._internal.usage(trx, account));
const backlog = account => mail._internal.locked(trx => mail._internal.backlog(trx, account));
const days = n => new Date(Date.now() + n * 86400000);
const warnings = pattern => logger.warn.mock.calls.filter(([text]) => pattern.test(String(text)));
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
  logger = require('../../src/utils/logger');
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
  mockMessages = []; mockDownloads.length = 0; mockSeen.length = 0;
  mail._internal.warned.clear();
  jest.restoreAllMocks();
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
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

test('a capacity refusal stores nothing, leaves the mail unread, warns once and imports it when room frees', async () => {
  process.env.EMAIL_INTAKE_MAILBOX_BYTES = '50000';
  mockMessages = Array.from({ length: 20 }, () => message({ text: 'body'.repeat(1000) }));
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  expect(mockDownloads).toHaveLength(0);
  expect(mockSeen).toHaveLength(0);
  expect(await db('received_emails')).toHaveLength(0);
  expect((await db('mail_intake_state').where({ key: 'installation' }).first()).blocked_count).toBeGreaterThan(0);
  // A waiting message must not use up the hourly budgets either.
  expect(await db('mail_intake_state').where('key', 'like', 'rate:%')).toHaveLength(0);
  expect(warnings(/"accounting".*EMAIL_INTAKE_MAILBOX_BYTES \(50000\)/)).toHaveLength(1);
  delete process.env.EMAIL_INTAKE_MAILBOX_BYTES;
  expect(await intake.pollOnce()).toEqual({ processed: 20 });
  expect(mockSeen).toHaveLength(20);
});

test('booked documents and their audit allowance leave the admission backlog', async () => {
  const first = await capture();
  const second = await capture(Buffer.from('a second, different supplier scan'));
  const pending = await backlog('accounting');
  expect(pending).toEqual({ bytes: 2 * mail.AUDIT_BYTES + image.length + 33, rows: 2 });
  process.env.EMAIL_INTAKE_MAILBOX_BYTES = String(pending.bytes + 50000);
  expect((await claim()).reason).toMatch(/capacity/);
  await expense.updateInbound(first.doc.id, { supplierName: 'Supplier', totalAmountMinor: 10000 }, adminId);
  await expense.updateInbound(second.doc.id, { supplierName: 'Supplier', totalAmountMinor: 20000 }, adminId);
  expect(await backlog('accounting')).toEqual({ bytes: 0, rows: 0 });
  // Still retained and still accounted for, just no longer a reason to stop.
  expect((await usage('accounting')).bytes).toBeGreaterThan(pending.bytes);
  expect((await claim()).skip).toBeUndefined();
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
  process.env.EMAIL_INTAKE_INSTALLATION_PER_HOUR = '2';
  expect((await claim('new-mailbox', 20000, 'rotated@example.net')).reason).toMatch(/rate/);
});

test('a sender-rate refusal is not persisted: the message waits unread and is imported in the next window', async () => {
  process.env.EMAIL_INTAKE_SENDER_PER_HOUR = '1';
  mockMessages = [message({ attachment: null }), message({ attachment: null }), message({ attachment: null, sender: 'other@example.com' })];
  expect(await intake.pollOnce()).toEqual({ processed: 2 });
  expect(mockDownloads).toHaveLength(2);
  expect(mockSeen).toHaveLength(2);
  expect(await db('received_emails')).toHaveLength(2);
  expect(warnings(/EMAIL_INTAKE_SENDER_PER_HOUR \(1\)/)).toHaveLength(1);
  // Refused attempts did not charge the mailbox or installation windows.
  expect(Number((await db('mail_intake_state').where({ key: 'installation' }).first()).window_count)).toBe(2);
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  await db('mail_intake_state').where('key', 'like', 'rate:sender:%').update({ window_start: new Date(Date.now() - 2 * 3600000).toISOString() });
  expect(await intake.pollOnce()).toEqual({ processed: 1 });
  expect((await db('received_emails')).every(row => row.status === 'no_attachment')).toBe(true);
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

test('without EMAIL_INTAKE_RETENTION_DAYS nothing is ever removed by age', async () => {
  const kept = await capture();
  mockMessages = [message({ attachment: null })];
  await intake.pollOnce();
  for (let i = 0; i < 6; i++) await mail.sweep({ now: days(4000) });
  const rows = await db('received_emails');
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.body_text && row.status !== 'expired')).toBe(true);
  expect(await db('inbound_documents')).toHaveLength(1);
  expect(await db('mail_intake_files')).toHaveLength(1);
  expect(await fs.promises.readFile(kept.filePath)).toEqual(image);
});

test('a retention inside the mailbox lookback is raised above it with one warning', async () => {
  process.env.EMAIL_INTAKE_RETENTION_DAYS = '30';
  expect(mail.policy().retentionDays).toBe(mail.LOOKBACK_DAYS + 1);
  expect(mail.policy().retentionDays).toBe(mail.LOOKBACK_DAYS + 1);
  expect(warnings(/EMAIL_INTAKE_RETENTION_DAYS=30/)).toHaveLength(1);
  process.env.EMAIL_INTAKE_RETENTION_DAYS = '0';
  expect(mail.policy().retentionDays).toBe(0);
});

test('enabled retention removes disposable duplicate captures and unreferenced owned files, not append-only audit charges', async () => {
  process.env.EMAIL_INTAKE_RETENTION_DAYS = '91';
  const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
  await capture(); await capture();
  for (let i = 0; i < 6; i++) await mail.sweep({ now: days(92) });
  // The messages stay as body-less rows until they have left the lookback.
  const rows = await db('received_emails');
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.status === 'expired' && row.mailbox_state === 'expired' && row.body_text === null && row.subject === null && row.message_id)).toBe(true);
  expect(await db('inbound_documents')).toHaveLength(0);
  expect(await db('mail_intake_files')).toHaveLength(0);
  expect(await fs.promises.readdir(path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound', 'mail'))).toHaveLength(0);
  expect(info.mock.calls.some(([text]) => /retention 91 days.*removed 1 untouched document/.test(text))).toBe(true);
  await mail.sweep({ now: days(98) });
  expect(await db('received_emails')).toHaveLength(0);
  expect((await usage()).bytes).toBe(2 * mail.AUDIT_BYTES);
  expect((await db('accounting_change_history').where({ source: 'inbound.retention' })).length).toBeGreaterThanOrEqual(2);
});

test('enabled retention keeps archived mail and expires only unlinked, unarchived messages', async () => {
  process.env.EMAIL_INTAKE_RETENTION_DAYS = '120';
  mockMessages = ['inbox', 'archived', 'trash', 'legacy'].map(text => message({ attachment: null, text }));
  expect(await intake.pollOnce()).toEqual({ processed: 4 });
  const state = text => db('received_emails').where('body_text', 'like', `${text}%`);
  await state('archived').update({ mailbox_state: 'archived' });
  await state('trash').update({ mailbox_state: 'deleted' });
  await state('legacy').update({ mailbox_state: null });
  await mail.sweep({ now: days(119) });
  expect(await db('received_emails').where({ status: 'expired' })).toHaveLength(0);
  await mail.sweep({ now: days(121) });
  expect((await state('archived').first()).status).toBe('no_attachment');
  expect(await db('received_emails').where({ status: 'expired' })).toHaveLength(3);
  // Out of the lookback window the body-less rows go; the archived one stays.
  await mail.sweep({ now: days(4000) });
  expect((await db('received_emails')).map(row => row.body_text.trim())).toEqual(['archived']);
});

test('an expired message that is still in the mailbox lookback is not imported again', async () => {
  process.env.EMAIL_INTAKE_RETENTION_DAYS = '91';
  mockMessages = [message({ attachment: null })];
  expect(await intake.pollOnce()).toEqual({ processed: 1 });
  await mail.sweep({ now: days(92) });
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  expect(mockDownloads).toHaveLength(1);
  const rows = await db('received_emails');
  expect(rows.map(row => [row.message_id, row.status, row.body_text])).toEqual([[mockMessages[0].id, 'expired', null]]);
});

test('the short metadata window only removes bare refusal records', async () => {
  const stamp = new Date().toISOString();
  const bare = { account_key: 'accounting', status: 'error', error: 'Message too large', retained_bytes: mail.META_BYTES, created_at: stamp, received_at: stamp };
  const linked = await capture();
  await db('received_emails').insert([
    { ...bare, message_id: '<bare@example.com>' },
    { ...bare, message_id: '<archived@example.com>', mailbox_state: 'archived' },
    { ...bare, message_id: '<parsed@example.com>', subject: 'Invoice 12', from_address: 'supplier@example.com' },
    { ...bare, message_id: '<document@example.com>', inbound_document_id: linked.doc.id },
  ]);
  await db('received_emails').where({ id: linked.admitted.id }).update({ status: 'error', body_text: null, subject: null, inbound_document_id: null });
  await mail.sweep({ now: days(8) });
  expect((await db('received_emails').orderBy('id').select('message_id')).map(row => row.message_id)).not.toContain('<bare@example.com>');
  expect(await db('received_emails')).toHaveLength(4);
});

test('curated/rebilled and linked proofs survive retention together with the messages they came from', async () => {
  process.env.EMAIL_INTAKE_RETENTION_DAYS = '91';
  const curated = await capture();
  await expense.updateInbound(curated.doc.id, { supplierName: 'Supplier', totalAmountMinor: 10000 }, adminId);
  await db('customer_accounts').where({ id: customerId }).update({ billing_cadence: 'monthly' });
  const billed = await expense.categorizeInbound(curated.doc.id, { disposition: 'rebill', customerAccountId: customerId }, adminId);
  expect(billed.billedInvoiceId).toBeTruthy();
  const linked = await capture(Buffer.from('different supplier image'));
  await db('expenses').insert({ inbound_document_id: linked.doc.id, disposition: 'eigener_aufwand', tax_treatment: 'domestic', status: 'open' });
  for (let i = 0; i < 4; i++) await mail.sweep({ now: days(92) });
  expect((await db('received_emails')).map(row => [row.status, row.body_text])).toEqual([['ingested', 'Invoice body'], ['ingested', 'Invoice body']]);
  expect(await db('inbound_documents')).toHaveLength(2);
  expect(await db('mail_intake_files')).toHaveLength(2);
  expect(await fs.promises.readFile(curated.filePath)).toEqual(image);
  expect((await usage()).bytes).toBeGreaterThan(2 * mail.AUDIT_BYTES);
});

test('legacy backfill is idempotent, charges measured sizes and never blocks new mail', async () => {
  const captured = await capture();
  const gone = await capture(Buffer.from('a legacy scan that is no longer on disk'));
  await fs.promises.unlink(gone.filePath);
  await db('mail_intake_files').del();
  await db('inbound_documents').update({ received_email_id: null });
  await db('received_emails').where({ id: captured.admitted.id }).update({ retained_bytes: 0 });
  const migration = require('../../migrations/core/244_incoming_mail_retention');
  await migration.up(db); await migration.up(db);
  const files = await db('mail_intake_files').orderBy('byte_size');
  expect(files.map(file => Number(file.byte_size))).toEqual([0, image.length]);
  expect(files.every(file => /^\d{4}-\d\d-\d\dT.*Z$/.test(file.created_at))).toBe(true);
  expect(warnings(/1 captured attachment file\(s\) could not be measured/)).toHaveLength(1);
  // Everything captured before the ledger is over this budget on its own.
  process.env.EMAIL_INTAKE_MAILBOX_BYTES = '120000';
  process.env.EMAIL_INTAKE_INSTALLATION_BYTES = '120000';
  expect((await usage()).bytes).toBeGreaterThan(120000);
  expect(await backlog()).toEqual({ bytes: 0, rows: 0 });
  expect((await claim()).skip).toBeUndefined();
});

test('a referenced file that went missing is charged nothing, with one warning', async () => {
  const captured = await capture();
  await fs.promises.unlink(captured.filePath);
  await db('mail_intake_files').update({ created_at: new Date(Date.now() - 3600000).toISOString() });
  for (let i = 0; i < 4; i++) await mail.sweep();
  const file = await db('mail_intake_files').first();
  expect(Number(file.byte_size)).toBe(0);
  expect(await db('inbound_documents')).toHaveLength(1);
  expect(warnings(/still referenced but missing/)).toHaveLength(1);
});

test('legacy stale processing rows without leases are fenced and reduced to bounded metadata', async () => {
  await db('received_emails').insert({ message_id: '<legacy-crash@example.com>', account_key: 'accounting', status: 'processing', retained_bytes: 100000, created_at: new Date(Date.now() - 3600000).toISOString() });
  await mail.sweep();
  const row = await db('received_emails').where({ message_id: '<legacy-crash@example.com>' }).first();
  expect(row.status).toBe('error');
  expect(Number(row.retained_bytes)).toBe(mail.META_BYTES);
});

test('an unsafe file is logged and skipped; the rest of the batch is still swept', async () => {
  const orphan = await claim();
  const orphanPath = await mail.saveAttachment({ content: image }, orphan);
  await mail.fail(orphan, new Error('crashed before document creation'));
  const poison = 'business-docs/inbound/mail/email-' + '0'.repeat(64) + '.bin';
  const poisonPath = require('../../src/utils/storedPath').resolveStoredPath(poison);
  const canary = path.join(tmpDir, 'outside-inbound.txt');
  await fs.promises.writeFile(canary, 'do not remove');
  await fs.promises.symlink(canary, poisonPath);
  await db('mail_intake_files').insert({ file_path: poison, file_sha256: '0'.repeat(64), account_key: 'accounting', byte_size: 1, created_at: new Date().toISOString() });
  await db('mail_intake_files').update({ created_at: new Date(Date.now() - 3600000).toISOString() });
  await mail.sweep();
  expect(warnings(/sweep skipped .*email-0{64}\.bin/)).toHaveLength(1);
  expect((await db('mail_intake_files')).map(file => file.file_path)).toEqual([poison]);
  expect(fs.existsSync(orphanPath)).toBe(false);
  expect(await fs.promises.readFile(canary, 'utf8')).toBe('do not remove');
});

test('attachment bytes are written outside the admission lock', async () => {
  const held = await claim();
  const original = fs.promises.writeFile;
  let admittedDuringWrite = null;
  jest.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
    // Another message can be admitted while this one is still on its way to disk.
    if (String(args[0]).includes('/inbound/mail/')) admittedDuringWrite = await claim('customers');
    return original(...args);
  });
  const filePath = await mail.saveAttachment({ content: image }, held);
  expect(admittedDuringWrite.token).toBeTruthy();
  expect(await fs.promises.readFile(filePath)).toEqual(image);
  expect((await db('mail_intake_files').first()).created_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
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
