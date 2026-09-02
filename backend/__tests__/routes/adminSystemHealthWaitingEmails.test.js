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

  it('reports what the queue processor last did', async () => {
    const body = await failures();
    // Never started in this process — which is the condition that makes a
    // pending row invisible, so the page has to be able to say it.
    expect(body.processor).toEqual(expect.objectContaining({ started: false }));
    expect(body.processor).toHaveProperty('lastRunAt');
    expect(body.processor).toHaveProperty('lastError');
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
