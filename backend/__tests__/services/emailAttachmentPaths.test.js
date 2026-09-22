/**
 * Email attachments name files by path, and email_queue rows travel in a
 * .picpeak archive. A queued attachment must be a file under the storage
 * root: anything else fails the email with the reason in its queue row
 * rather than mailing the file (or silently dropping the attachment).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'attachment-paths-test-secret';

const { bootCrmDb } = require('../integration/helpers/crmDb');

let db; let cleanup; let root; let outside;

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

function put(rel, content = '%PDF-1.4 test') {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function queue(attachments) {
  const [row] = await db('email_queue').insert({
    recipient_email: 'someone@example.com', email_type: 'gallery_created', status: 'pending', retry_count: 0,
    created_at: new Date().toISOString(), scheduled_at: new Date().toISOString(),
    email_data: JSON.stringify({ invoice_number: 'I-1', attachments }),
  }).returning('id');
  return row.id ?? row;
}

async function send(id) {
  const { processEmailQueue } = require('../../src/services/emailProcessor');
  const stub = stubWebhookTransport();
  try {
    await processEmailQueue({ ignoreSchedule: true, onlyId: id });
  } finally { stub.restore(); }
  return { mails: stub.mails, row: await db('email_queue').where({ id }).first() };
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  root = process.env.STORAGE_PATH;
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-outside-'));
  expect(await db('email_templates').where({ template_key: 'gallery_created' }).first()).toBeTruthy();
});
afterAll(async () => {
  fs.rmSync(outside, { recursive: true, force: true });
  if (cleanup) await cleanup();
});

test('a file each sender writes goes out as an attachment', async () => {
  // Where every sender that attaches a file writes it (none uses a temp dir):
  // quote and invoice PDFs, the Mahnung, contract PDFs and certificates,
  // separately delivered contract attachments, re-bill proofs (inbound) and
  // the dev test email's synthetic PDFs.
  const files = [
    'business-docs/quote/2026/Q-1.pdf',
    'business-docs/invoice/2026/I-1.pdf',
    'business-docs/mahnung/2026/I-1_Mahnung.pdf',
    'business-docs/contract/2026/C-1_fully-signed.pdf',
    'business-docs/contract/2026/C-1_certificate.pdf',
    'business-docs/attachments/abc.pdf',
    'business-docs/inbound/2026/email-1.pdf',
    'business-docs/dev-test/quote.pdf',
    'uploads/contracts/signed/wet.pdf',
  ].map((rel) => ({ rel, abs: put(rel) }));
  const id = await queue(files.map((f) => ({ filename: path.basename(f.rel), contentPath: f.abs, contentType: 'application/pdf' })));
  const { mails, row } = await send(id);
  expect(row.status).toBe('sent');
  expect(mails).toHaveLength(1);
  expect(mails[0].attachments.map((a) => path.basename(a.path))).toEqual(files.map((f) => path.basename(f.rel)));
  for (const a of mails[0].attachments) expect(fs.existsSync(a.path)).toBe(true);
});

test('a path outside the storage root fails the email with the reason, and sends nothing', async () => {
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'root:x:0:0');
  for (const target of [secret, '/etc/passwd', '../../../etc/hosts']) {
    const id = await queue([{ filename: 'invoice.pdf', contentPath: target, contentType: 'application/pdf' }]);
    const { mails, row } = await send(id);
    expect(mails).toHaveLength(0);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/Attachment "invoice\.pdf" was refused/);
    expect(row.error_message).not.toContain(target);
  }
});

test('a symlink inside storage that points outside it is refused too', async () => {
  const secret = path.join(outside, 'linked.txt');
  fs.writeFileSync(secret, 'secret');
  const link = path.join(root, 'business-docs', 'invoice', '2026', 'linked.pdf');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(secret, link);
  const id = await queue([{ filename: 'linked.pdf', contentPath: link, contentType: 'application/pdf' }]);
  const { mails, row } = await send(id);
  expect(mails).toHaveLength(0);
  expect(row.status).toBe('failed');
  expect(row.error_message).toMatch(/refused/);
});

test('a row queued before a restore onto another root still sends the restored file', async () => {
  const file = put('business-docs/invoice/2026/I-9.pdf');
  const id = await queue([{ filename: 'I-9.pdf', contentPath: '/app/storage/business-docs/invoice/2026/I-9.pdf', contentType: 'application/pdf' }]);
  const { mails, row } = await send(id);
  expect(row.status).toBe('sent');
  expect(mails[0].attachments[0].path).toBe(fs.realpathSync(file));
});
