/**
 * Inbound mail: the parsed body stays bounded by the raw message size.
 *
 * mailparser's simpleParser, with default options, replaces every `cid:`
 * reference in the HTML part with the full data: URI of the matching inline
 * attachment. A message with one inline image and many references then parses
 * into an HTML string many times larger than the message itself. The intake
 * keeps cid links as they are, so the stored body grows with the source only.
 *
 * Uses the real mailparser; only the IMAP client is stubbed. Sizes are small
 * (32 KiB image, 200 references) so the unbounded variant stays well inside
 * test memory while still being clearly distinguishable.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-intake-cid-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'intake-test-secret';

const MSGID = '<inline-refs@example.com>';
const REFS = 200;

function buildMessage() {
  const image = crypto.randomBytes(32 * 1024).toString('base64').replace(/(.{76})/g, '$1\r\n');
  const html = `<p>${'<img src="cid:p1">'.repeat(REFS)}</p>`;
  return Buffer.from([
    'From: sender@example.com',
    'To: intake@example.com',
    'Subject: inline refs',
    `Message-ID: ${MSGID}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '--b1',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <p1>',
    'Content-Disposition: inline; filename="p1.png"',
    '',
    image,
    '--b1--',
    '',
  ].join('\r\n'));
}

const mockSource = buildMessage();

jest.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async getMailboxLock() { return { release() {} }; }
    async search() { return [21]; }
    async *fetch() {
      yield { uid: 21, size: mockSource.length, envelope: { messageId: '<inline-refs@example.com>' } };
    }
    async fetchOne() { return { source: mockSource }; }
    async messageFlagsAdd() { return true; }
  },
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('email intake keeps inline cid references unexpanded', () => {
  let db; let cleanup; let pollResult;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    await db('feature_flags')
      .insert({ key: 'incomingMail', value: 1 })
      .onConflict('key').merge({ value: 1 });
    const imapFields = {
      imap_host: 'imap.example.com',
      imap_user: 'intake@example.com',
      imap_pass: 'x',
      imap_folder: 'INBOX',
    };
    const existingCfg = await db('email_configs').first();
    if (existingCfg) {
      await db('email_configs').where({ id: existingCfg.id }).update(imapFields);
    } else {
      await db('email_configs').insert({
        smtp_host: 'smtp.example.com', smtp_port: 587, from_email: 'intake@example.com', ...imapFields,
      });
    }
    const intake = require('../../src/services/emailIntakeService');
    pollResult = await intake.pollOnce().catch((e) => ({ thrown: e.message }));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('ran the poll', () => {
    expect(pollResult).toBeDefined();
    expect(pollResult.skipped).toBeUndefined();
    expect(pollResult.thrown).toBeUndefined();
  });

  it('finishes the message with a body no larger than its source', async () => {
    const row = await db('received_emails').where({ message_id: MSGID }).first();
    expect(row).toBeTruthy();
    expect(row.status).not.toBe('processing');
    expect(row.error || null).toBeNull();
    const body = String(row.body_html || '');
    expect(body).toContain('cid:p1');
    expect(body.length).toBeLessThan(mockSource.length);
  });
});
