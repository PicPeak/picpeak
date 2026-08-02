/**
 * Inbound-mail resource caps (GHSA-2qf9).
 *
 * emailIntakeService downloaded, parsed and persisted every message with no
 * size, attachment-count or attachment-byte limit. Anyone who can email the
 * operator's mailbox reaches this path unauthenticated.
 *
 * The teeth were in the dedup key: on failure the service wrote an error row
 * keyed `err-<uid>-<Date.now()>`, which can never match the envelope-derived
 * `messageId` the dedup pass compares against. So the same oversized message
 * was re-downloaded every poll interval forever — and an OOM-kill/restart just
 * resumed the loop. This pins that an over-limit message is (a) never
 * downloaded and (b) recorded under its REAL message id so it dedups.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-intake-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'intake-test-secret';
process.env.EMAIL_INTAKE_MAX_MESSAGE_BYTES = '1000';

const OVERSIZED_UID = 11;
const NORMAL_UID = 12;
const OVERSIZED_MSGID = '<huge@example.com>';

const fetchOneCalls = [];

jest.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async getMailboxLock() { return { release() {} }; }
    async search() { return [OVERSIZED_UID, NORMAL_UID]; }
    // Envelope pass now also returns `size`.
    async *fetch() {
      yield { uid: OVERSIZED_UID, size: 50_000, envelope: { messageId: OVERSIZED_MSGID } };
      yield { uid: NORMAL_UID, size: 500, envelope: { messageId: '<ok@example.com>' } };
    }
    async fetchOne(uid) {
      fetchOneCalls.push(String(uid));
      return { source: Buffer.from('Subject: ok\r\n\r\nbody') };
    }
    async messageFlagsAdd() { return true; }
  },
}));

jest.mock('mailparser', () => ({
  simpleParser: async () => ({
    messageId: '<ok@example.com>',
    subject: 'ok',
    date: new Date(),
    attachments: [],
    text: 'body',
    html: null,
  }),
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('email intake caps (GHSA-2qf9)', () => {
  let db; let cleanup; let intake;

  let pollResult;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    // pollOnce short-circuits unless the feature flag is on AND an IMAP
    // account is configured — without both, this suite would pass vacuously.
    await db('feature_flags')
      .insert({ key: 'incomingMail', value: 1 })
      .onConflict('key').merge({ value: 1 });
    // getImapConfig() reads email_configs.first() — seedMinimal may already
    // have inserted a row, so update that one rather than adding a second
    // (the first row would win and report "unconfigured").
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
        smtp_host: 'smtp.example.com',
        smtp_port: 587,
        from_email: 'intake@example.com',
        ...imapFields,
      });
    }

    intake = require('../../src/services/emailIntakeService');
    pollResult = await intake.pollOnce().catch((e) => ({ thrown: e.message }));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('actually ran the poll (guards against a vacuous suite)', () => {
    expect(pollResult).toBeDefined();
    expect(pollResult.skipped).toBeUndefined();
  });

  it('never downloads a message whose envelope size exceeds the cap', () => {
    // The oversized uid must never reach fetchOne (the source download) —
    // that download is the DoS. The normal one must still be processed.
    expect(fetchOneCalls).not.toContain(String(OVERSIZED_UID));
    expect(fetchOneCalls).toContain(String(NORMAL_UID));
  });

  it('records the skip under the REAL message id so it dedups next poll', async () => {
    const row = await db('received_emails').where({ message_id: OVERSIZED_MSGID }).first();
    expect(row).toBeTruthy();
    expect(row.status).toBe('error');
    expect(String(row.error)).toMatch(/too large/i);
    // The whole point: keyed by messageId, NOT err-<uid>-<timestamp>, which
    // could never match the dedup pass and so looped forever.
    expect(row.message_id).not.toMatch(/^err-/);
  });
});
