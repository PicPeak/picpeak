/**
 * Newsletter campaigns — render, recipients, queue, processor hook (#1264).
 *
 * These run against a real (temp SQLite) DB because the interesting parts of
 * this feature are all row-level: which customers are selected, what
 * `scheduled_at` values get written, whether the transaction rolls back, and
 * whether an opt-out that lands AFTER queueing still stops the send.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('newsletter campaigns', () => {
  let db;
  let cleanup;
  let adminId;
  let newsletterService;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'newsletter-test-secret';
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    newsletterService = require('../../src/services/newsletterService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('email_campaign_recipients').del();
    await db('email_queue').del();
    await db('email_campaigns').del();
    await db('customer_accounts').del();
  });

  async function seedCustomer(overrides = {}) {
    const row = {
      email: `c${Math.random().toString(36).slice(2, 10)}@example.com`,
      first_name: 'Alex',
      last_name: 'Sample',
      display_name: 'Alex Sample',
      company_name: 'Sample & Co',
      preferred_language: 'en',
      is_active: 1,
      marketing_opt_out: 0,
      created_at: new Date().toISOString(),
      ...overrides,
    };
    const [id] = await db('customer_accounts').insert(row).returning('id');
    return { id: typeof id === 'object' ? id.id : id, ...row };
  }

  async function seedCampaign(overrides = {}) {
    return await newsletterService.createCampaign({
      name: 'Spring news',
      subject: 'Our spring offers',
      bodyHtml: '<p>Hi {{first_name}}, welcome!</p>',
      ...overrides,
    }, adminId);
  }

  // ---- recipients --------------------------------------------------------

  describe('resolveRecipients', () => {
    it('selects active, opted-in customers with an email', async () => {
      await seedCustomer({ email: 'in@example.com' });
      const campaign = await seedCampaign();

      const { recipients, skippedOptOut } = await newsletterService.resolveRecipients(campaign);

      expect(recipients.map((r) => r.email)).toEqual(['in@example.com']);
      expect(skippedOptOut).toBe(0);
    });

    it('skips opted-out customers and counts them', async () => {
      await seedCustomer({ email: 'in@example.com' });
      await seedCustomer({ email: 'out@example.com', marketing_opt_out: 1 });
      const campaign = await seedCampaign();

      const { recipients, skippedOptOut } = await newsletterService.resolveRecipients(campaign);

      expect(recipients.map((r) => r.email)).toEqual(['in@example.com']);
      expect(skippedOptOut).toBe(1);
    });

    it('skips inactive customers', async () => {
      await seedCustomer({ email: 'in@example.com' });
      await seedCustomer({ email: 'gone@example.com', is_active: 0 });
      const campaign = await seedCampaign();

      const { recipients } = await newsletterService.resolveRecipients(campaign);
      expect(recipients.map((r) => r.email)).toEqual(['in@example.com']);
    });

    it('collapses duplicate addresses so one person is mailed once', async () => {
      await seedCustomer({ email: 'same@example.com' });
      await seedCustomer({ email: 'SAME@example.com' });
      const campaign = await seedCampaign();

      const { recipients } = await newsletterService.resolveRecipients(campaign);
      expect(recipients).toHaveLength(1);
    });

    it('scopes a manual campaign to the named ids only', async () => {
      const a = await seedCustomer({ email: 'a@example.com' });
      await seedCustomer({ email: 'b@example.com' });
      const campaign = await seedCampaign({
        recipientMode: 'manual', customerIds: [a.id],
      });

      const { recipients } = await newsletterService.resolveRecipients(campaign);
      expect(recipients.map((r) => r.email)).toEqual(['a@example.com']);
    });

    it('still honours opt-out inside a manual id list', async () => {
      const a = await seedCustomer({ email: 'a@example.com', marketing_opt_out: 1 });
      const campaign = await seedCampaign({ recipientMode: 'manual', customerIds: [a.id] });

      const { recipients, skippedOptOut } = await newsletterService.resolveRecipients(campaign);
      expect(recipients).toHaveLength(0);
      expect(skippedOptOut).toBe(1);
    });

    it('skips every row sharing an opted-out address', async () => {
      // #1285 review: unsubscribing flips only the row whose token was in the
      // mail. Filtering row-by-row skipped that one and still delivered to
      // the same inbox through the duplicate — so the link appeared to do
      // nothing.
      await seedCustomer({ email: 'shared@example.com', marketing_opt_out: 1 });
      await seedCustomer({ email: 'SHARED@example.com', marketing_opt_out: 0 });
      await seedCustomer({ email: 'other@example.com' });
      const campaign = await seedCampaign();

      const { recipients, skippedOptOut } = await newsletterService.resolveRecipients(campaign);

      expect(recipients.map((r) => r.email)).toEqual(['other@example.com']);
      // Counted once for the address, not once per row.
      expect(skippedOptOut).toBe(1);
    });

    it('returns nobody for a manual campaign with no ids', async () => {
      await seedCustomer();
      const campaign = await seedCampaign({ recipientMode: 'manual', customerIds: [] });

      const { recipients } = await newsletterService.resolveRecipients(campaign);
      expect(recipients).toHaveLength(0);
    });
  });

  // ---- rendering ---------------------------------------------------------

  describe('renderForRecipient', () => {
    it('substitutes the customer variables', async () => {
      const customer = await seedCustomer({ first_name: 'Jamie', email: 'j@example.com' });
      const campaign = await seedCampaign({ bodyHtml: '<p>Hi {{first_name}} at {{company_name}}</p>' });

      const { html } = await newsletterService.renderForRecipient(campaign, customer);

      expect(html).toContain('Hi Jamie at Sample &amp; Co');
    });

    it('escapes customer data on substitution', async () => {
      // A customer's own company name is untrusted text — it must not be
      // able to inject markup by riding in through a variable.
      const customer = await seedCustomer({ company_name: '<script>alert(1)</script>' });
      const campaign = await seedCampaign({ bodyHtml: '<p>{{company_name}}</p>' });

      const { html } = await newsletterService.renderForRecipient(campaign, customer);

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('resolves {{#if}} blocks', async () => {
      const withCompany = await seedCustomer({ company_name: 'Acme' });
      const without = await seedCustomer({ company_name: null });
      const campaign = await seedCampaign({
        bodyHtml: '<p>Hi{{#if company_name}} from {{company_name}}{{/if}}!</p>',
      });

      expect((await newsletterService.renderForRecipient(campaign, withCompany)).html)
        .toContain('Hi from Acme!');
      expect((await newsletterService.renderForRecipient(campaign, without)).html)
        .toContain('Hi!');
    });

    it('includes a working unsubscribe URL for the recipient', async () => {
      const customer = await seedCustomer();
      const campaign = await seedCampaign({ bodyHtml: '<p><a href="{{unsubscribe_url}}">Stop</a></p>' });

      const { html } = await newsletterService.renderForRecipient(campaign, customer);

      const match = html.match(/\/api\/public\/newsletter\/unsubscribe\/([A-Za-z0-9_-]+)/);
      expect(match).not.toBeNull();
      expect(newsletterService.verifyUnsubscribeToken(match[1])).toBe(customer.id);
    });

    it('prefers the customer language over the campaign language', async () => {
      const german = await seedCustomer({ preferred_language: 'de' });
      const campaign = await seedCampaign({ language: 'en' });

      expect((await newsletterService.renderForRecipient(campaign, german)).language).toBe('de');
    });

    it('falls back to the campaign language when the customer has none', async () => {
      const customer = await seedCustomer({ preferred_language: null });
      const campaign = await seedCampaign({ language: 'de' });

      expect((await newsletterService.renderForRecipient(campaign, customer)).language).toBe('de');
    });

    it('inlines the sanitized CSS into the body', async () => {
      const customer = await seedCustomer();
      const campaign = await seedCampaign({ bodyCss: '.cta { color: #fff; }' });

      const { html } = await newsletterService.renderForRecipient(campaign, customer);
      expect(html).toContain('.cta { color: #fff; }');
    });

    it('re-sanitizes a body that was stored unsanitized', async () => {
      // Simulates a row written by an older/buggier version: the render path
      // must not trust what is in the column.
      const customer = await seedCustomer();
      const campaign = await seedCampaign();
      await db('email_campaigns').where({ id: campaign.id })
        .update({ body_html: '<p>hi</p><script>alert(1)</script>' });
      const tainted = await newsletterService.getCampaign(campaign.id);

      const { html } = await newsletterService.renderForRecipient(tainted, customer);
      expect(html).not.toContain('alert(1)');
    });

    it('wraps the body in the standard email chrome', async () => {
      const customer = await seedCustomer();
      const campaign = await seedCampaign();

      const { html } = await newsletterService.renderForRecipient(campaign, customer);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('email-footer');
    });
  });

  // ---- unsubscribe tokens ------------------------------------------------

  describe('unsubscribe tokens', () => {
    it('round-trips a customer id', () => {
      const token = newsletterService.unsubscribeToken(4242);
      expect(newsletterService.verifyUnsubscribeToken(token)).toBe(4242);
    });

    it('rejects a tampered signature', () => {
      const token = newsletterService.unsubscribeToken(1);
      const decoded = Buffer.from(token, 'base64url').toString('utf8');
      const tampered = Buffer.from(decoded.replace(/.$/, 'f'), 'utf8').toString('base64url');
      expect(newsletterService.verifyUnsubscribeToken(tampered)).toBeNull();
    });

    it("rejects another customer's id spliced onto a valid signature", () => {
      const token = newsletterService.unsubscribeToken(1);
      const sig = Buffer.from(token, 'base64url').toString('utf8').split('.')[1];
      const forged = Buffer.from(`2.${sig}`, 'utf8').toString('base64url');
      expect(newsletterService.verifyUnsubscribeToken(forged)).toBeNull();
    });

    it.each([['', 'empty'], ['not-a-token', 'garbage'], ['!!!', 'non-base64']])
      ('rejects %s (%s)', (token) => {
        expect(newsletterService.verifyUnsubscribeToken(token)).toBeNull();
      });

    it('rejects null and non-strings', () => {
      expect(newsletterService.verifyUnsubscribeToken(null)).toBeNull();
      expect(newsletterService.verifyUnsubscribeToken(undefined)).toBeNull();
      expect(newsletterService.verifyUnsubscribeToken(123)).toBeNull();
    });
  });

  // ---- queueing ----------------------------------------------------------

  describe('queueCampaign', () => {
    it('writes one queue row and one recipient row per recipient', async () => {
      await seedCustomer({ email: 'a@example.com' });
      await seedCustomer({ email: 'b@example.com' });
      const campaign = await seedCampaign();

      const result = await newsletterService.queueCampaign(campaign.id, adminId);

      expect(result.queued).toBe(2);
      const queue = await db('email_queue').where({ campaign_id: campaign.id });
      expect(queue).toHaveLength(2);
      expect(queue.every((r) => r.email_type === 'newsletter')).toBe(true);
      expect(queue.every((r) => r.origin === 'campaign')).toBe(true);
      expect(queue.every((r) => r.status === 'pending')).toBe(true);
      expect(await db('email_campaign_recipients').where({ campaign_id: campaign.id }))
        .toHaveLength(2);
    });

    it('staggers scheduled_at by the send rate', async () => {
      for (let i = 0; i < 5; i += 1) await seedCustomer({ email: `r${i}@example.com` });
      const campaign = await seedCampaign({ sendRatePerMinute: 2 });

      await newsletterService.queueCampaign(campaign.id, adminId);

      const rows = await db('email_queue')
        .where({ campaign_id: campaign.id }).orderBy('id', 'asc');
      const minutes = rows.map((r) => Math.round(
        (new Date(r.scheduled_at).getTime() - new Date(rows[0].scheduled_at).getTime()) / 60000
      ));
      // 2 per minute → minute 0, 0, 1, 1, 2.
      expect(minutes).toEqual([0, 0, 1, 1, 2]);
    });

    it('writes queue timestamps in the engine shape the processor compares', async () => {
      // #1285 review: storing ISO TEXT in a column the processor compares
      // against a Date-bound value meant SQLite never matched the row — every
      // INTEGER sorts below every TEXT — so campaigns silently sent nothing
      // on SQLite installs.
      //
      // The due-predicate itself CANNOT be exercised here: under jest a
      // sandbox-created Date binds as a string (the landmine documented in
      // CLAUDE.md), so `INTEGER <= TEXT` is trivially true and every row
      // reads as due whatever the fix does. So assert the stored SHAPE
      // against the production shape utils/queueTimestamps documents for
      // this engine instead.
      await seedCustomer({ email: 'a@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);

      const [row] = await db('email_queue').where({ campaign_id: campaign.id });

      // SQLite: epoch ms, exactly what queueEmail's Date becomes through the
      // native binding. Never an ISO string, which is what regressed.
      expect(typeof row.scheduled_at).toBe('number');
      expect(typeof row.created_at).toBe('number');
      expect(Number.isFinite(row.scheduled_at)).toBe(true);
      // Still a sane instant, not a truncated or NaN value.
      expect(Math.abs(row.scheduled_at - Date.now())).toBeLessThan(120000);
    });

    it('clamps an absurd send rate', async () => {
      await seedCustomer();
      const campaign = await seedCampaign({ sendRatePerMinute: 100000 });

      const result = await newsletterService.queueCampaign(campaign.id, adminId);
      expect(result.sendRatePerMinute).toBe(newsletterService.MAX_RATE_PER_MINUTE);
    });

    it('moves the campaign to queued and records the recipient count', async () => {
      await seedCustomer();
      const campaign = await seedCampaign();

      await newsletterService.queueCampaign(campaign.id, adminId);

      const after = await newsletterService.getCampaign(campaign.id);
      expect(after.status).toBe('queued');
      expect(after.recipient_count).toBe(1);
      expect(after.queued_at).toBeTruthy();
    });

    it('refuses to queue a campaign twice', async () => {
      await seedCustomer();
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);

      await expect(newsletterService.queueCampaign(campaign.id, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses to queue with no recipients', async () => {
      const campaign = await seedCampaign();
      await expect(newsletterService.queueCampaign(campaign.id, adminId))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuses to queue an empty body', async () => {
      await seedCustomer();
      const campaign = await seedCampaign({ bodyHtml: '' });
      await expect(newsletterService.queueCampaign(campaign.id, adminId))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it('leaves nothing behind when the transaction fails', async () => {
      await seedCustomer({ email: 'a@example.com' });
      await seedCustomer({ email: 'b@example.com' });
      const campaign = await seedCampaign();

      // Force the second insert to fail: a unique (campaign_id,
      // customer_account_id) row already exists for one of them.
      const [{ id: firstId }] = await db('customer_accounts').select('id').orderBy('id').limit(1);
      await db('email_campaign_recipients').insert({
        campaign_id: campaign.id, customer_account_id: firstId,
        email: 'a@example.com', status: 'queued', created_at: new Date().toISOString(),
      });

      await expect(newsletterService.queueCampaign(campaign.id, adminId)).rejects.toThrow();

      // A partial queue — half a customer list mailed — is the outcome the
      // transaction exists to prevent.
      expect(await db('email_queue').where({ campaign_id: campaign.id })).toHaveLength(0);
      expect((await newsletterService.getCampaign(campaign.id)).status).toBe('draft');
    });
  });

  // ---- cancel ------------------------------------------------------------

  describe('cancel', () => {
    it('removes pending rows and leaves sent ones alone', async () => {
      await seedCustomer({ email: 'a@example.com' });
      await seedCustomer({ email: 'b@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);

      // Pretend the first one already went out.
      const rows = await db('email_queue').where({ campaign_id: campaign.id }).orderBy('id');
      await db('email_queue').where({ id: rows[0].id })
        .update({ status: 'sent', sent_at: new Date().toISOString() });
      await db('email_campaign_recipients')
        .where({ campaign_id: campaign.id, email_queue_id: rows[0].id })
        .update({ status: 'sent' });

      const result = await newsletterService.cancel(campaign.id, adminId);

      expect(result.cancelled).toBe(1);
      const remaining = await db('email_queue').where({ campaign_id: campaign.id });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('sent');
      expect((await newsletterService.getCampaign(campaign.id)).status).toBe('cancelled');
    });

    it('refuses to delete a cancelled campaign that already reached someone', async () => {
      // The recipient rows cascade, and they are the only durable record of
      // who received the mail once queue rows are pruned (#1285 review).
      await seedCustomer({ email: 'a@example.com' });
      await seedCustomer({ email: 'b@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);
      const rows = await db('email_queue').where({ campaign_id: campaign.id }).orderBy('id');
      await db('email_queue').where({ id: rows[0].id })
        .update({ status: 'sent', sent_at: new Date().toISOString() });
      await db('email_campaign_recipients')
        .where({ campaign_id: campaign.id, email_queue_id: rows[0].id })
        .update({ status: 'sent' });
      await newsletterService.cancel(campaign.id, adminId);

      await expect(newsletterService.deleteCampaign(campaign.id, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it('still deletes a cancelled campaign that reached nobody', async () => {
      await seedCustomer({ email: 'a@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);
      await newsletterService.cancel(campaign.id, adminId);

      await expect(newsletterService.deleteCampaign(campaign.id, adminId))
        .resolves.toEqual({ deleted: true });
    });

    it('refuses to cancel a draft', async () => {
      const campaign = await seedCampaign();
      await expect(newsletterService.cancel(campaign.id, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // ---- processor bookkeeping --------------------------------------------

  describe('recordRecipientResult / recomputeCounts', () => {
    it('moves the campaign to sending on the first result, then to sent', async () => {
      await seedCustomer({ email: 'a@example.com' });
      await seedCustomer({ email: 'b@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);
      const rows = await db('email_queue').where({ campaign_id: campaign.id }).orderBy('id');

      await newsletterService.recordRecipientResult(rows[0], { status: 'sent' });
      expect((await newsletterService.getCampaign(campaign.id)).status).toBe('sending');

      await newsletterService.recordRecipientResult(rows[1], { status: 'sent' });
      const done = await newsletterService.getCampaign(campaign.id);
      expect(done.status).toBe('sent');
      expect(done.sent_count).toBe(2);
      expect(done.completed_at).toBeTruthy();
    });

    it('counts a partial failure as a sent campaign, not a failed one', async () => {
      await seedCustomer({ email: 'a@example.com' });
      await seedCustomer({ email: 'b@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);
      const rows = await db('email_queue').where({ campaign_id: campaign.id }).orderBy('id');

      await newsletterService.recordRecipientResult(rows[0], { status: 'sent' });
      await newsletterService.recordRecipientResult(rows[1], {
        status: 'failed', errorMessage: 'mailbox full',
      });

      const done = await newsletterService.getCampaign(campaign.id);
      expect(done.status).toBe('sent');
      expect(done.sent_count).toBe(1);
      expect(done.failed_count).toBe(1);
    });

    it('marks the campaign failed only when nothing got through', async () => {
      await seedCustomer({ email: 'a@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);
      const [row] = await db('email_queue').where({ campaign_id: campaign.id });

      await newsletterService.recordRecipientResult(row, { status: 'failed', errorMessage: 'nope' });
      expect((await newsletterService.getCampaign(campaign.id)).status).toBe('failed');
    });

    it('does not double-count a repeated result', async () => {
      await seedCustomer({ email: 'a@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);
      const [row] = await db('email_queue').where({ campaign_id: campaign.id });

      await newsletterService.recordRecipientResult(row, { status: 'sent' });
      await newsletterService.recordRecipientResult(row, { status: 'sent' });

      expect((await newsletterService.getCampaign(campaign.id)).sent_count).toBe(1);
    });
  });

  // ---- send-time opt-out re-check ---------------------------------------

  describe('send-time opt-out', () => {
    it('skips a customer who unsubscribed after the campaign was queued', async () => {
      const customer = await seedCustomer({ email: 'a@example.com' });
      const campaign = await seedCampaign();
      await newsletterService.queueCampaign(campaign.id, adminId);
      const [row] = await db('email_queue').where({ campaign_id: campaign.id });

      // The gap this closes: consent withdrawn between queue and send.
      await newsletterService.setMarketingOptOut(customer.id, true, 'link');
      expect(await newsletterService.shouldSkipForOptOut(customer.id)).toBe(true);

      await newsletterService.markSkippedOptOut(row);

      const recipient = await db('email_campaign_recipients')
        .where({ campaign_id: campaign.id }).first();
      expect(recipient.status).toBe('skipped_opt_out');
      expect((await db('email_queue').where({ id: row.id }).first()).status).toBe('cancelled');
    });

    it('skips a customer deactivated after queueing', async () => {
      const customer = await seedCustomer();
      await db('customer_accounts').where({ id: customer.id }).update({ is_active: 0 });
      expect(await newsletterService.shouldSkipForOptOut(customer.id)).toBe(true);
    });

    it('does not skip an ordinary opted-in customer', async () => {
      const customer = await seedCustomer();
      expect(await newsletterService.shouldSkipForOptOut(customer.id)).toBe(false);
    });
  });

  // ---- opt-out column ----------------------------------------------------

  describe('setMarketingOptOut', () => {
    it('stamps a timestamp when opting out and clears it when opting back in', async () => {
      const customer = await seedCustomer();

      await newsletterService.setMarketingOptOut(customer.id, true, 'link');
      let row = await db('customer_accounts').where({ id: customer.id }).first();
      expect(row.marketing_opt_out).toBeTruthy();
      expect(row.marketing_opt_out_at).toBeTruthy();

      await newsletterService.setMarketingOptOut(customer.id, false, 'admin');
      row = await db('customer_accounts').where({ id: customer.id }).first();
      expect(row.marketing_opt_out).toBeFalsy();
      expect(row.marketing_opt_out_at).toBeNull();
    });

    it('ignores a repeated opt-out and preserves the original timestamp', async () => {
      // #1285 review: link scanners, prefetchers and refreshes all re-hit an
      // unsubscribe URL. Rewriting the timestamp each time buries the moment
      // consent was actually withdrawn, and files a duplicate activity row.
      const customer = await seedCustomer();
      await newsletterService.setMarketingOptOut(customer.id, true, 'link');
      const first = await db('customer_accounts').where({ id: customer.id }).first();

      const second = await newsletterService.setMarketingOptOut(customer.id, true, 'link');

      expect(second).toBe(false);
      const after = await db('customer_accounts').where({ id: customer.id }).first();
      expect(after.marketing_opt_out_at).toBe(first.marketing_opt_out_at);

      const logs = (await db('activity_logs')
        .where({ activity_type: 'customer_marketing_opt_out' }))
        .filter((row) => JSON.parse(row.metadata).customerId === customer.id);
      expect(logs).toHaveLength(1);
    });

    it('reports no-op for an unknown customer', async () => {
      expect(await newsletterService.setMarketingOptOut(999999, true, 'link')).toBe(false);
    });

    it('writes an activity log entry naming the source', async () => {
      const customer = await seedCustomer();
      await newsletterService.setMarketingOptOut(customer.id, true, 'portal');

      const log = await db('activity_logs')
        .where({ activity_type: 'customer_marketing_opt_out' }).orderBy('id', 'desc').first();
      expect(JSON.parse(log.metadata).source).toBe('portal');
    });
  });
});
