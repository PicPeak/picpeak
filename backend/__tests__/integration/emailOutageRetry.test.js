/**
 * A mail server outage must not use up a mail's attempts. The queue runs once a
 * minute and stops after three failures, so without this a three-minute outage
 * stranded every gallery delivery mail until an admin retried it by hand.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mail-outage-')), 'test.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mail-outage-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mail-outage-storage-'));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// Recorded from real nodemailer 10 against a local server failing at each stage.
const REAL = {
  refused: { code: 'ESOCKET', command: 'CONN', syscall: 'connect' },
  dns: { code: 'EDNS', command: 'CONN', syscall: 'getaddrinfo' },
  noGreeting: { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'GREETING_TIMEOUT' },
  // An unroutable host: a firewall dropping packets, or a dead machine.
  unroutable: { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'CONNECT_TIMEOUT' },
  stalledAfterBody: { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' },
  droppedAfterBody: { code: 'ECONNECTION', command: 'CONN' },
  resetAfterBody: { code: 'ESOCKET', command: 'CONN', syscall: 'read' },
};

describe('mail server outage', () => {
  let db; let cleanup; let transport; let enabled; let send;

  async function queueMail(createdAt = new Date()) {
    const inserted = await db('email_queue').insert({
      recipient_email: 'guest@example.com',
      email_type: 'gallery_created',
      email_data: JSON.stringify({ gallery_name: 'Test', subject: 'Test' }),
      status: 'pending',
      created_at: createdAt.toISOString(),
      // Explicit NULL, as queueEmail writes it. The column default is the
      // database's clock, and one a few milliseconds ahead of Node's left
      // every row not yet due.
      scheduled_at: null,
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  }

  const run = () => require('../../src/services/emailProcessor').processEmailQueue();
  const row = (id) => db('email_queue').where({ id }).first();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    process.env.EMAIL_FROM = 'noreply@example.com';
    transport = require('../../src/services/emailWebhookTransport');
    enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
    send = jest.spyOn(transport, 'send');
  }, 120000);

  afterAll(async () => {
    enabled.mockRestore();
    send.mockRestore();
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    send.mockReset();
    await db('email_queue').del();
  });

  it('defers a mail on a connection failure without spending an attempt', async () => {
    const id = await queueMail();
    send.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), REAL.refused));
    await run();
    const deferred = await row(id);
    expect(deferred).toMatchObject({ status: 'pending', retry_count: 0 });
    expect(deferred.error_message).toContain('ECONNREFUSED');
    expect(deferred.scheduled_at).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a refused connection', REAL.refused],
    ['a name that does not resolve', REAL.dns],
    ['a host that drops packets', REAL.unroutable],
    ['a server that never greets', REAL.noGreeting],
  ])('defers on %s and ends the pass', async (_label, shape) => {
    const id = await queueMail();
    await queueMail();
    send.mockRejectedValue(Object.assign(new Error('unavailable'), shape));
    await run();
    expect(await row(id)).toMatchObject({ status: 'pending', retry_count: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('spends an attempt when the same shape comes from outside the transport', async () => {
    // A refused database connection looks like a refused mail server. Only the
    // send itself may defer, or a delivered mail could go out again.
    const notifier = require('../../src/services/downloadJobNotifier');
    const stale = jest.spyOn(notifier, 'staleMailReason')
      .mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), REAL.refused));
    try {
      const inserted = await db('email_queue').insert({
        recipient_email: 'guest@example.com',
        email_type: 'download_ready',
        email_data: JSON.stringify({ subject: 'Test' }),
        status: 'pending',
        created_at: new Date().toISOString(),
        scheduled_at: null,
      }).returning('id');
      const id = inserted[0]?.id ?? inserted[0];
      await run();
      expect(await row(id)).toMatchObject({ retry_count: 1 });
      expect(send).not.toHaveBeenCalled();
    } finally {
      stale.mockRestore();
    }
  });

  it('skips a deferred mail until its time comes, then sends it', async () => {
    const id = await queueMail();
    send.mockRejectedValueOnce(Object.assign(new Error('Greeting never received'), REAL.noGreeting));
    await run();
    const { queueTimestamp, toMillis } = require('../../src/utils/queueTimestamps');
    expect(toMillis((await row(id)).scheduled_at)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    send.mockResolvedValue({ html: '<p>ok</p>' });
    // Jest's sandbox Dates do not bind on SQLite (see adminSystemHealth.js), so
    // the processor's schedule filter can only be exercised on Postgres.
    if (db.client.config.client === 'pg') {
      await run();
      expect(send).toHaveBeenCalledTimes(1);
    }

    await db('email_queue').where({ id }).update({ scheduled_at: queueTimestamp(Date.now() - 1000) });
    await run();
    expect((await row(id)).status).toBe('sent');
  });

  it('stops the pass instead of hitting a dead server once per mail', async () => {
    await queueMail();
    await queueMail();
    send.mockRejectedValue(Object.assign(new Error('Greeting never received'), REAL.noGreeting));
    await run();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still spends an attempt on an error about the mail itself', async () => {
    const id = await queueMail();
    const before = await row(id);
    send.mockRejectedValue(Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }));
    await run();
    expect(await row(id)).toMatchObject({ retry_count: 1, scheduled_at: before.scheduled_at });
  });

  const status = () => require('../../src/services/emailProcessor').getQueueProcessorStatus();
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), REAL.refused);

  async function endOutage() {
    send.mockResolvedValue({ html: '<p>ok</p>' });
    await queueMail();
    await run();
    await db('email_queue').del();
  }

  it('waits before retrying a greylisted recipient, and moves on to the next mail', async () => {
    await endOutage();
    const id = await queueMail();
    const next = await queueMail();
    send.mockRejectedValueOnce(Object.assign(new Error('greylisted'), { code: 'EENVELOPE', responseCode: 450, command: 'RCPT TO' }));
    send.mockResolvedValue({ html: '<p>ok</p>' });
    await run();
    const { toMillis } = require('../../src/utils/queueTimestamps');
    const row1 = await row(id);
    expect(row1.retry_count).toBe(1);
    expect(toMillis(row1.scheduled_at)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    expect((await row(next)).status).toBe('sent');
  });

  it('treats a server refusing the sender for now as an outage', async () => {
    await endOutage();
    const id = await queueMail();
    send.mockRejectedValue(Object.assign(new Error('try later'), { code: 'EENVELOPE', responseCode: 421, command: 'MAIL FROM' }));
    await run();
    expect((await row(id)).retry_count).toBe(0);
    expect(status().outage).toBeTruthy();
  });

  it('treats the webhook transport being down as an outage', async () => {
    await endOutage();
    const id = await queueMail();
    send.mockRejectedValue(Object.assign(new Error('email webhook returned 503'), { code: 'EWEBHOOK_UNAVAILABLE' }));
    await run();
    expect((await row(id)).retry_count).toBe(0);
  });

  it('forgets an outage that went quiet, so old time does not count against a new one', async () => {
    await endOutage();
    await queueMail();
    send.mockRejectedValue(refused());
    await run();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60 * 1000);
    expect(status().outage).toBeNull();
    clock.mockRestore();
  });

  it('reports the outage until a mail gets through', async () => {
    await endOutage();
    expect(status().outage).toBeNull();
    await queueMail();
    send.mockRejectedValue(refused());
    await run();
    expect(status().outage).toMatchObject({ error: 'connect ECONNREFUSED' });
    await endOutage();
    expect(status().outage).toBeNull();
  });

  it('protects a mail queued long before the outage began', async () => {
    await endOutage();
    const id = await queueMail(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    send.mockRejectedValue(refused());
    await run();
    expect((await row(id)).retry_count).toBe(0);
  });

  const daysAgo = (days) => {
    const { queueTimestamp } = require('../../src/utils/queueTimestamps');
    return queueTimestamp(Date.now() - days * 24 * 60 * 60 * 1000);
  };

  it('keeps the time of a mail\'s first deferral on the row', async () => {
    await endOutage();
    const id = await queueMail();
    send.mockRejectedValue(refused());
    await run();
    const { toMillis } = require('../../src/utils/queueTimestamps');
    const first = toMillis((await row(id)).deferred_since);
    expect(first).toBeGreaterThan(Date.now() - 60 * 1000);
    await db('email_queue').where({ id }).update({ scheduled_at: null });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000);
    try {
      await run();
    } finally {
      clock.mockRestore();
    }
    expect(toMillis((await row(id)).deferred_since)).toBe(first);
  });

  it('goes back to the attempt cap three days after a mail was first deferred', async () => {
    await endOutage();
    const id = await queueMail();
    await db('email_queue').where({ id }).update({ deferred_since: daysAgo(2.9) });
    send.mockRejectedValue(refused());
    await run();
    expect((await row(id)).retry_count).toBe(0);
    await db('email_queue').where({ id }).update({ deferred_since: daysAgo(3.1), scheduled_at: null });
    await run();
    expect((await row(id)).retry_count).toBe(1);
  });

  it('does not restart that count when other mail gets through, or after a restart', async () => {
    // A row refused on its own, while the rest of the queue flows. endOutage()
    // clears what the processor holds in memory, as a restart would.
    await endOutage();
    const id = await queueMail();
    await db('email_queue').where({ id }).update({ deferred_since: daysAgo(3.1) });
    send.mockRejectedValue(Object.assign(new Error('try later'), { code: 'EENVELOPE', responseCode: 421, command: 'MAIL FROM' }));
    await run();
    expect((await row(id)).retry_count).toBe(1);
  });

  it('starts the count again when an admin retries the mail', async () => {
    await endOutage();
    const id = await queueMail();
    await db('email_queue').where({ id }).update({ deferred_since: daysAgo(3.1), status: 'failed', retry_count: 3 });
    await require('../../src/services/projectService').retryEmail(id);
    expect(await row(id)).toMatchObject({ status: 'pending', retry_count: 0, deferred_since: null });
  });

  it('gives the full allowance again once the server has answered the mail', async () => {
    await endOutage();
    const id = await queueMail();
    await db('email_queue').where({ id }).update({ deferred_since: daysAgo(1) });
    send.mockRejectedValue(Object.assign(new Error('greylisted'), { code: 'EENVELOPE', responseCode: 450, command: 'RCPT TO' }));
    await run();
    expect(await row(id)).toMatchObject({ retry_count: 1, deferred_since: null });
  });

  it('reads a webhook receiver\'s refusal as an answer', async () => {
    await endOutage();
    const id = await queueMail();
    await db('email_queue').where({ id }).update({ deferred_since: daysAgo(1) });
    send.mockRejectedValue(Object.assign(new Error('email webhook returned 500'), { responseStatus: 500 }));
    await run();
    expect(await row(id)).toMatchObject({ retry_count: 1, deferred_since: null });
  });

  // A connection lost at an unknown stage spends an attempt, but nothing
  // answered: the outage the mail waited out may still be going on.
  it.each(['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET'])(
    'keeps the deferral start after a lost connection (%s)',
    async (code) => {
      await endOutage();
      const id = await queueMail();
      const since = daysAgo(1);
      await db('email_queue').where({ id }).update({ deferred_since: since });
      send.mockRejectedValue(Object.assign(new Error('connection lost'), { code }));
      await run();
      const after = await row(id);
      expect(after.retry_count).toBe(1);
      const { toMillis } = require('../../src/utils/queueTimestamps');
      expect(toMillis(after.deferred_since)).toBe(toMillis(since));
    },
  );

  it('counts only the mail a pass actually tried', async () => {
    await endOutage();
    await queueMail();
    await queueMail();
    send.mockRejectedValue(refused());
    expect(await run()).toMatchObject({ processed: 1, deferred: 1 });
  });

  it('shows the queue card why mail is waiting, also on the passes that find nothing due', async () => {
    await endOutage();
    await queueMail();
    send.mockRejectedValue(refused());
    await run();
    expect(status().lastError).toBe('connect ECONNREFUSED');
    // The deferred row is not due for 5 minutes; the passes in between find nothing.
    await db('email_queue').del();
    await run();
    expect(status().lastError).toBe('connect ECONNREFUSED');
    await endOutage();
    expect(status().lastError).toBeNull();
  });

  it.each([
    ['a stall after the body went out', REAL.stalledAfterBody],
    ['a drop after the body went out', REAL.droppedAfterBody],
    ['a reset after the body went out', REAL.resetAfterBody],
    ['a recipient the server refuses for good', { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }],
  ])('spends an attempt on %s, so it can never repeat past the cap', async (_label, shape) => {
    await endOutage();
    const id = await queueMail();
    send.mockRejectedValue(Object.assign(new Error('try later'), shape));
    await run();
    expect((await row(id)).retry_count).toBe(1);
    expect(status().outage).toBeNull();
  });

  it('waits before retrying a send that may have arrived', async () => {
    await endOutage();
    const id = await queueMail();
    send.mockRejectedValue(Object.assign(new Error('Timeout'), REAL.stalledAfterBody));
    await run();
    const { toMillis } = require('../../src/utils/queueTimestamps');
    expect(toMillis((await row(id)).scheduled_at)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
  });

  it('reports a deferred mail apart from sent and failed', async () => {
    await endOutage();
    await queueMail();
    send.mockRejectedValue(refused());
    expect(await run()).toMatchObject({ sent: 0, failed: 0, deferred: 1 });
  });
});
