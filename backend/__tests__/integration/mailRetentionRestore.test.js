const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mail-restore-')), 'db.sqlite');
process.env.SKIP_S3_TESTS = 'true';
process.env.EMAIL_INTAKE_MAX_ATTACHMENTS = '2';
process.env.JWT_SECRET = 'owned-mail-restore-fixture-secret-at-least-32-characters';

let mockMessages = [];
const mockDownloads = [];
jest.mock('imapflow', () => ({ ImapFlow: class {
  constructor() { this.mailbox = { uidValidity: 17 }; }
  async connect() {} async logout() {}
  async getMailboxLock() { return { release() {} }; }
  async search() { return mockMessages.map(m => m.uid); }
  async *fetch() {
    for (const m of mockMessages) yield { uid: m.uid, size: m.source.length, envelope: { messageId: m.id, from: [{ address: 'supplier@example.com' }] } };
  }
  async fetchOne(uid) { mockDownloads.push(Number(uid)); return { source: mockMessages.find(m => String(m.uid) === String(uid)).source }; }
  async messageFlagsAdd() {}
} }));
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
jest.setTimeout(120000);
let db, cleanup, tmpDir, adminId, mail, intake, image, exporter, importer;
let seq = 0;
function message() {
  const uid = ++seq;
  const id = `<restore-${uid}@example.com>`;
  return { uid, id, source: Buffer.from(`Message-ID: ${id}\r\nFrom: supplier@example.com\r\nTo: intake@example.com\r\nSubject: supplier invoice\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOrdinary invoice ä\r\n--x\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=invoice.png\r\nContent-Transfer-Encoding: base64\r\n\r\n${image.toString('base64')}\r\n--x--\r\n`) };
}
beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  require('../../src/database/db').logActivity = async () => {};
  ({ adminId } = await seedMinimal(db));
  image = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  mail = require('../../src/services/mailRetentionService');
  intake = require('../../src/services/emailIntakeService');
  exporter = require('../../src/services/picpeakExportService');
  importer = require('../../src/services/picpeakImportService');
  await db('feature_flags').insert({ key: 'incomingMail', value: 1 }).onConflict('key').merge({ value: 1 });
  const cfg = { imap_host: 'imap.example.com', imap_user: 'intake@example.com', imap_pass: 'owned-fixture', imap_folder: 'INBOX' };
  const old = await db('email_configs').first();
  if (old) await db('email_configs').where({ id: old.id }).update(cfg);
  else await db('email_configs').insert({ smtp_host: 'smtp.example.com', smtp_port: 587, from_email: 'intake@example.com', ...cfg });
});
beforeEach(async () => {
  for (const key of Object.keys(process.env).filter(k => k.startsWith('EMAIL_INTAKE_') && k !== 'EMAIL_INTAKE_MAX_ATTACHMENTS')) delete process.env[key];
  mockMessages = []; mockDownloads.length = 0;
  await db('received_emails').del(); await db('inbound_documents').del();
  await db('mail_intake_files').del(); await db('mail_intake_state').del();
  await db('mail_intake_state').insert({ key: 'installation' });
  await fs.promises.rm(path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound'), { recursive: true, force: true });
});
afterAll(async () => { if (cleanup) await cleanup(); });

test('pre-ledger archive rebuilds actual mail accounting, discards local state and permits ordinary intake within quota', async () => {
  mockMessages = [message(), message()];
  expect(await intake.pollOnce()).toEqual({ processed: 2 });
  const original = (await db('mail_intake_files').first()).file_path;
  const legacy = 'business-docs/inbound/2026/email-1000-123.png';
  await fs.promises.mkdir(path.dirname(path.join(process.env.STORAGE_PATH, legacy)), { recursive: true });
  await fs.promises.rename(path.join(process.env.STORAGE_PATH, original), path.join(process.env.STORAGE_PATH, legacy));
  await db('inbound_documents').update({ file_path: legacy });
  await db.schema.dropTable('mail_intake_files'); await db.schema.dropTable('mail_intake_state');
  await db.schema.alterTable('received_emails', t => t.dropColumns('retained_bytes', 'claim_token', 'claim_expires_at'));
  await db.schema.alterTable('inbound_documents', t => t.dropColumns('mail_account_key', 'received_email_id'));
  const archive = await exporter.createPicpeak({ includePhotos: false, outDir: path.join(tmpDir, 'old-archives') });
  expect(archive.manifest.tables.mail_intake_state).toBeUndefined();
  await require('../../migrations/core/270_incoming_mail_retention').up(db);
  await db('mail_intake_state').insert({ key: 'rate:mail:foreign-install', window_count: 99 });
  await db('mail_intake_state').where({ key: 'audit:accounting' }).update({ retained_audit_bytes: 999999999 });
  expect((await importer.importFromPicpeak({ picpeakPath: archive.filePath, currentAdminId: adminId })).restored).toBe(true);
  expect(await db('mail_intake_state').where({ key: 'installation' }).first()).toBeTruthy();
  expect(await db('mail_intake_state').where({ key: 'rate:mail:foreign-install' }).first()).toBeUndefined();
  const rows = await db('received_emails');
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(Number(row.retained_bytes)).toBe(mail.META_BYTES + Buffer.byteLength(row.body_text || '') + Buffer.byteLength(row.body_html || ''));
  expect(Number((await db('mail_intake_state').where({ key: 'audit:accounting' }).first()).retained_audit_bytes)).toBe(2 * mail.AUDIT_BYTES);
  expect(Number((await db('mail_intake_files').first()).byte_size)).toBe(2 ** 42);
  await mail.sweep();
  expect(Number((await db('mail_intake_files').first()).byte_size)).toBe(image.length);
  expect(await fs.promises.readFile(path.join(process.env.STORAGE_PATH, legacy))).toEqual(image);
  const used = await mail._internal.locked(trx => mail._internal.usage(trx));
  process.env.EMAIL_INTAKE_INSTALLATION_BYTES = String(used.bytes + 100);
  mockMessages = [message()]; mockDownloads.length = 0;
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  expect(mockDownloads).toHaveLength(0);
  process.env.EMAIL_INTAKE_INSTALLATION_BYTES = String(2 * 1024 ** 3);
  expect(await intake.pollOnce()).toEqual({ processed: 1 });
  expect(mockDownloads).toHaveLength(1);
  expect(await db('inbound_documents')).toHaveLength(3);
  expect(await db('mail_intake_files')).toHaveLength(1);
  expect((await db('inbound_documents').orderBy('id', 'desc').first()).file_path).toBe(legacy);
});

test('modern archive preserves recorded audit allowances and admission windows rather than resetting capacity', async () => {
  mockMessages = [message()];
  expect(await intake.pollOnce()).toEqual({ processed: 1 });
  await db('mail_intake_state').where({ key: 'audit:accounting' }).update({ retained_audit_bytes: 3 * mail.AUDIT_BYTES });
  const archive = await exporter.createPicpeak({ includePhotos: false, outDir: path.join(tmpDir, 'modern-archives') });
  await db('mail_intake_state').del();
  await db('mail_intake_state').insert({ key: 'installation', window_count: 55 });
  await db('mail_intake_state').insert({ key: 'audit:foreign-install', retained_audit_bytes: 999999 });
  expect((await importer.importFromPicpeak({ picpeakPath: archive.filePath, currentAdminId: adminId })).restored).toBe(true);
  expect(Number((await db('mail_intake_state').where({ key: 'audit:accounting' }).first()).retained_audit_bytes)).toBe(3 * mail.AUDIT_BYTES);
  expect(Number((await db('mail_intake_state').where({ key: 'installation' }).first()).window_count)).toBe(1);
  expect(await db('mail_intake_state').where({ key: 'audit:foreign-install' }).first()).toBeUndefined();
  process.env.EMAIL_INTAKE_SENDER_PER_HOUR = '1';
  mockMessages = [message()]; mockDownloads.length = 0;
  expect(await intake.pollOnce()).toEqual({ processed: 0 });
  expect(mockDownloads).toHaveLength(0);
  expect((await db('received_emails').where({ status: 'error' }).first()).error).toMatch(/rate/);
});

