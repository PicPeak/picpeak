/**
 * Boot-time email-template self-heal:
 *   1. Seeds the CRM / contract / event-reminder templates on an
 *      install that's never had them before.
 *   2. Recovers email_queue rows that previously exhausted their
 *      retries because their template was missing.
 *
 * The failure that triggered this fix (2026-05-27) had Ralf's beta
 * box failing every `quote_sent` / `invoice_sent` send for ~14h
 * because crmEmailTemplates.ensureCrmEmailTemplatesSeeded was
 * defined but never called. After 3 retries the rows sat in
 * status='pending' forever; nothing in the admin UI signalled the
 * problem. Both halves of that regression are covered here.
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('email template self-heal at boot', () => {
  let db;
  let cleanup;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('seeds crm/contract/event-reminder templates and recovers stuck queue rows', async () => {
    // Sanity: a fresh CRM-migrated DB does NOT carry CRM templates —
    // 107_crm_consolidated documents the deliberate split (templates
    // are self-healed at runtime, not inserted by the migration).
    const before = await db('email_templates')
      .whereIn('template_key', ['quote_sent', 'invoice_sent', 'storno_issued'])
      .pluck('template_key');
    expect(before).toEqual([]);

    // Seed a stuck queue row that mirrors what we found on Ralf's box:
    // quote_sent send attempted 3 times, each time failed because the
    // template didn't exist, queue processor gave up.
    const queueRowIds = await db('email_queue').insert({
      recipient_email: 'customer@example.com',
      email_type: 'quote_sent',
      email_data: JSON.stringify({ quote_number: 'Q-2026-0001' }),
      status: 'pending',
      retry_count: 3,
      error_message: "Email template 'quote_sent' not found",
      created_at: new Date(),
    }).returning('id');
    const queueRowId = typeof queueRowIds[0] === 'object' ? queueRowIds[0].id : queueRowIds[0];

    // Also seed an UNRELATED stuck row (different template, NOT one
    // we're going to insert) to confirm the recovery is targeted —
    // it must not blanket-reset every retry-exhausted row.
    const unrelatedIds = await db('email_queue').insert({
      recipient_email: 'someone@example.com',
      email_type: 'some_other_template',
      email_data: JSON.stringify({}),
      status: 'pending',
      retry_count: 3,
      error_message: 'SMTP timeout',
      created_at: new Date(),
    }).returning('id');
    const unrelatedId = typeof unrelatedIds[0] === 'object' ? unrelatedIds[0].id : unrelatedIds[0];

    // The seeders use module-level caches (`_seeded = true`). When
    // jest runs this test in isolation that cache starts fresh; in
    // the full suite no other test currently calls these seeders, so
    // the first call here also runs the real work. Reset the cache
    // defensively in case a future test changes that.
    jest.resetModules();
    const { seedEmailTemplatesAndRecoverQueue } = require('../../src/services/_emailTemplateBoot');

    const result = await seedEmailTemplatesAndRecoverQueue(db, null);

    // Templates landed.
    expect(result.seeded).toEqual(expect.arrayContaining([
      'quote_sent', 'invoice_sent', 'storno_issued',
    ]));
    const after = await db('email_templates')
      .whereIn('template_key', ['quote_sent', 'invoice_sent', 'storno_issued'])
      .pluck('template_key');
    expect(after.sort()).toEqual(['invoice_sent', 'quote_sent', 'storno_issued']);

    // Stuck quote_sent row was recovered.
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    const recoveredRow = await db('email_queue').where({ id: queueRowId }).first();
    expect(recoveredRow.retry_count).toBe(0);
    expect(recoveredRow.error_message).toBeNull();
    expect(recoveredRow.status).toBe('pending'); // ready for the next tick

    // Unrelated stuck row was NOT touched.
    const unrelatedRow = await db('email_queue').where({ id: unrelatedId }).first();
    expect(unrelatedRow.retry_count).toBe(3);
    expect(unrelatedRow.error_message).toBe('SMTP timeout');
  });

  it('also recovers a protected account-recovery row once its template is seeded', async () => {
    // Recovery mail waits in its own protected pending status; the processor
    // counts its retries the same way, so the self-heal has to reach it too.
    const { encryptEmailData, PROTECTED_PENDING_STATUS } = require('../../src/utils/emailQueueEncryption');
    const recipient = 'invited-customer@example.com';
    const ids = await db('email_queue').insert({
      recipient_email: recipient,
      email_type: 'customer_invitation',
      email_data: JSON.stringify(encryptEmailData(
        'customer_invitation', { invite_link: 'https://photos.example/customer/invite/x' }, recipient,
      )),
      status: PROTECTED_PENDING_STATUS,
      retry_count: 3,
      error_message: 'Email template customer_invitation not found',
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = typeof ids[0] === 'object' ? ids[0].id : ids[0];

    jest.resetModules();
    jest.doMock('../../src/services/crmEmailTemplates', () => ({
      ensureCrmEmailTemplatesSeeded: async () => ['customer_invitation'],
    }));
    try {
      const { seedEmailTemplatesAndRecoverQueue } = require('../../src/services/_emailTemplateBoot');
      const result = await seedEmailTemplatesAndRecoverQueue(db, null);
      expect(result.recovered).toBe(1);
    } finally {
      jest.dontMock('../../src/services/crmEmailTemplates');
    }

    const row = await db('email_queue').where({ id }).first();
    expect(row.retry_count).toBe(0);
    expect(row.error_message).toBeNull();
    expect(row.status).toBe(PROTECTED_PENDING_STATUS);
  });
});
