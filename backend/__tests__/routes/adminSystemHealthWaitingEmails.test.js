/**
 * System Health must not report "all clear" over a queue nobody is working (#1262).
 *
 * "Gallery email queued" reads as a delivery confirmation, and the two ways the
 * queue silently stops — the processor never started, or every pass returns
 * early because the transport will not initialise — leave every row at
 * status='pending' with retry_count 0. The old /failures query matched only
 * status='failed' or pending-with-retry_count>=3, so it matched none of them
 * and the page said everything was fine while nothing had been sent.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mailhealth-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailhealth-test-secret';

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal, buildRouteApp } = require('../integration/helpers/crmDb');

/**
 * Stand up a transport without touching a socket.
 *
 * processEmailQueue bails before it reads a single row when there is no
 * transport, so the two tests below cannot otherwise reach the code they are
 * about. Spying on the webhook transport is the cheapest way in — and it must
 * be a spy rather than a dead URL, because real connection attempts leave open
 * handles that destabilise unrelated suites in the same worker.
 *
 * `send` rejects: a failed delivery is a delivery ATTEMPT, which is exactly
 * what these two need to observe.
 */
function stubWebhookTransport() {
  const transport = require('../../src/services/emailWebhookTransport');
  const savedFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'noreply@example.com';
  const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
  const send = jest.spyOn(transport, 'send').mockRejectedValue(new Error('transport down'));
  return {
    send,
    restore() {
      enabled.mockRestore();
      send.mockRestore();
      if (savedFrom === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = savedFrom;
    },
  };
}

const MINUTE = 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();

describe('GET /admin/system-health/failures — waiting emails (#1262)', () => {
  let db; let cleanup; let app; let token;

  const queue = (row) => db('email_queue').insert({
    recipient_email: 'someone@example.com',
    email_type: 'gallery_created',
    email_data: '{}',
    status: 'pending',
    retry_count: 0,
    created_at: ago(60 * MINUTE),
    ...row,
  });

  const failures = async () => {
    const res = await request(app)
      .get('/admin/system-health/failures')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.data || res.body;
  };

  const typesOf = (rows) => rows.map((r) => r.emailType).sort();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const inserted = await db('admin_users').insert({
      username: 'mailhealth-admin',
      email: 'mailhealth-admin@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    const adminId = inserted[0]?.id ?? inserted[0];
    token = jwt.sign(
      { id: adminId, username: 'mailhealth-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = buildRouteApp('/admin/system-health', require('../../src/routes/adminSystemHealth'));
  });

  afterAll(async () => { await cleanup(); });
  afterEach(async () => { await db('email_queue').del(); });

  it('reports a due pending email the processor never picked up', async () => {
    // Exactly the shape "Gallery email queued" leaves behind when the worker
    // is not running: pending, no retries, no error, no scheduled_at.
    await queue({ email_type: 'gallery_created' });

    const body = await failures();
    expect(typesOf(body.waitingEmails)).toEqual(['gallery_created']);
    expect(body.counts.waitingEmails).toBe(1);
    // ...and it is NOT a failure, so the two buckets stay distinct.
    expect(body.stuckEmails).toEqual([]);
  });

  it('leaves a freshly queued email alone — the processor wakes every 60s', async () => {
    await queue({ email_type: 'customer_invitation', created_at: ago(30 * 1000) });

    const body = await failures();
    expect(body.waitingEmails).toEqual([]);
    expect(body.counts.waitingEmails).toBe(0);
  });

  it('leaves an email scheduled for later alone', async () => {
    // Split-payment invoices and the business-hours floor both park rows in
    // the future on purpose. Not being sent yet is the point of those.
    await queue({ email_type: 'invoice_due', scheduled_at: ahead(3 * 24 * 60 * MINUTE) });

    const body = await failures();
    expect(body.waitingEmails).toEqual([]);
  });

  it('counts a past-due scheduled email once its moment has come', async () => {
    await queue({ email_type: 'invoice_due', scheduled_at: ago(30 * MINUTE) });

    const body = await failures();
    expect(typesOf(body.waitingEmails)).toEqual(['invoice_due']);
  });

  it('does not double-count a retry-exhausted email as waiting', async () => {
    // retry_count >= 3 is already the `stuckEmails` bucket; listing it in both
    // would inflate the badge and make the two tables disagree.
    await queue({ email_type: 'quote_sent', retry_count: 3, error_message: 'template missing' });

    const body = await failures();
    expect(body.waitingEmails).toEqual([]);
    expect(typesOf(body.stuckEmails)).toEqual(['quote_sent']);
  });

  it('ignores emails that were sent', async () => {
    await queue({ email_type: 'gallery_created', status: 'sent', sent_at: ago(20 * MINUTE) });

    const body = await failures();
    expect(body.waitingEmails).toEqual([]);
    expect(body.stuckEmails).toEqual([]);
  });

  // --- cross-engine timestamps (Codex review round 1) -----------------------
  //
  // Every test above stores ISO strings, which is what CLAUDE.md prescribes
  // for jest + SQLite. Production SQLite does not: queueEmail writes a JS Date
  // and the native binding stores it as a ms-NUMBER. SQLite orders INTEGER
  // before TEXT whatever the values are, so the original WHERE clause -- a
  // ms-number column compared against a bound ISO string -- was true for every
  // row. Fresh mail read as ten minutes overdue and future schedules read as
  // due, on every SQLite deployment.
  describe('rows stored as epoch ms, the SQLite production shape', () => {
    const ms = (offset) => Date.now() + offset;

    it('does not report a mail queued seconds ago as waiting', async () => {
      await queue({ email_type: 'gallery_created', created_at: ms(-30 * 1000) });

      const body = await failures();
      expect(body.waitingEmails).toEqual([]);
      expect(body.counts.waitingEmails).toBe(0);
    });

    it('still reports a genuinely overdue one', async () => {
      await queue({ email_type: 'gallery_created', created_at: ms(-52 * MINUTE) });

      const body = await failures();
      expect(typesOf(body.waitingEmails)).toEqual(['gallery_created']);
    });

    it('leaves a future numeric scheduled_at alone', async () => {
      await queue({
        email_type: 'invoice_due',
        created_at: ms(-52 * MINUTE),
        scheduled_at: ms(3 * 24 * 60 * MINUTE),
      });

      const body = await failures();
      expect(body.waitingEmails).toEqual([]);
    });

    it('reports a past-due numeric scheduled_at', async () => {
      await queue({
        email_type: 'invoice_due',
        created_at: ms(-52 * MINUTE),
        scheduled_at: ms(-30 * MINUTE),
      });

      const body = await failures();
      expect(typesOf(body.waitingEmails)).toEqual(['invoice_due']);
    });

    it('mixes both storage shapes in one queue without confusing them', async () => {
      await queue({ email_type: 'gallery_created', created_at: ms(-52 * MINUTE) });
      await queue({ email_type: 'quote_sent', created_at: ago(52 * MINUTE) });
      await queue({ email_type: 'invoice_due', created_at: ms(-30 * 1000) });
      await queue({ email_type: 'customer_invitation', created_at: ago(30 * 1000) });

      const body = await failures();
      expect(typesOf(body.waitingEmails)).toEqual(['gallery_created', 'quote_sent']);
    });
  });

  // --- Codex review round 2 -------------------------------------------------
  //
  // The zone-less CURRENT_TIMESTAMP shape is covered in
  // __tests__/utils/queueTimestamps.test.js instead of here: this suite runs
  // in UTC, where reading such a value as local and as UTC give the same
  // answer, and process.env.TZ does not reliably re-bind mid-process. Those
  // tests force the zone in a child process, so they fail on any host.

  it('finds a due row behind a page full of future-scheduled ones', async () => {
    // Codex review round 2. The candidates used to be cut off with a single
    // LIMIT before the time filter ran, so a queue holding a page of
    // split-payment invoices scheduled for later hid the due row behind them
    // and reported an empty waiting list — the false all-clear, again.
    // Over the 1000-row cut-off the first attempt used, so the due row really
    // does sit behind a full page rather than merely late in one.
    const rows = [];
    for (let i = 0; i < 1200; i += 1) {
      rows.push({
        recipient_email: `bulk${i}@example.com`,
        email_type: 'invoice_due',
        email_data: '{}',
        status: 'pending',
        retry_count: 0,
        created_at: ago(90 * MINUTE),
        scheduled_at: ahead(30 * 24 * 60 * MINUTE),
      });
    }
    await db.batchInsert('email_queue', rows, 100);
    await queue({ email_type: 'gallery_created', created_at: ago(52 * MINUTE) });

    const body = await failures();
    expect(typesOf(body.waitingEmails)).toEqual(['gallery_created']);
  });

  it('reports what the queue processor last did', async () => {
    const body = await failures();
    // Never started in this process — which is the condition that makes a
    // pending row invisible, so the page has to be able to say it.
    expect(body.processor).toEqual(expect.objectContaining({ started: false }));
    expect(body.processor).toHaveProperty('lastRunAt');
    expect(body.processor).toHaveProperty('lastError');
  });

  it('does not attribute a previous pass\'s totals to an idle one', async () => {
    // Codex review round 1. The no-pending early return skipped the lastResult
    // assignment, so after one pass that sent or failed something, every idle
    // pass afterwards advanced lastRunAt while still reporting the old totals.
    const { processEmailQueue, getQueueProcessorStatus } = require('../../src/services/emailProcessor');
    const transport = stubWebhookTransport();

    try {
      await queue({ email_type: 'gallery_created' });
      await processEmailQueue();
      const worked = getQueueProcessorStatus().lastResult;
      expect(worked.processed).toBe(1);
      expect(worked.sent + worked.failed).toBe(1);

      await db('email_queue').del();
      await processEmailQueue();

      expect(getQueueProcessorStatus().lastResult).toEqual({ processed: 0, sent: 0, failed: 0 });
    } finally {
      transport.restore();
    }
  });

  it('actually flushes the row on retry instead of leaving it as it was', async () => {
    // Codex review round 1. The retry endpoint only wrote pending /
    // retry_count 0 / no schedule — which is exactly what a WAITING row
    // already is, so nothing happened while the toast said "re-queued". And
    // the usual reason a row is waiting is that nothing is working the queue,
    // so "wait for the next pass" is the one answer that cannot help.
    const transport = stubWebhookTransport();

    try {
      await queue({ email_type: 'gallery_created' });
      const { id } = await db('email_queue').first('id');

      const res = await request(app)
        .post(`/admin/system-health/failures/email/${id}/retry`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      // A send was ATTEMPTED, which the old endpoint never did. It fails here
      // (the transport is stubbed to reject) and that failure is recorded on
      // the row, which is itself the proof the row was worked rather than
      // merely rewritten to the state it was already in.
      expect(transport.send).toHaveBeenCalledTimes(1);
      const after = await db('email_queue').where({ id }).first();
      expect(after.retry_count).toBe(1);
      expect(after.error_message).toBeTruthy();
    } finally {
      transport.restore();
    }
  });

  it('surfaces the transport failure that makes every pass a no-op', async () => {
    const { processEmailQueue, getQueueProcessorStatus } = require('../../src/services/emailProcessor');
    await queue({ email_type: 'gallery_created' });

    // No SMTP configured, so initializeTransporter() yields nothing and the
    // pass returns early. Before #1262 that left no trace anywhere.
    await processEmailQueue();

    expect(getQueueProcessorStatus().lastError).toMatch(/transporter could not be initialised/i);
    const body = await failures();
    expect(body.processor.lastError).toMatch(/transporter could not be initialised/i);
    expect(body.counts.waitingEmails).toBe(1);
  });
});
