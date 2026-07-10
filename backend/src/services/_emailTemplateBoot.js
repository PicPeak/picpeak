/**
 * Boot-time wiring for the three self-heal seeders that own the
 * CRM-era email templates (quotes / invoices / Storno / payment
 * reminders / contract send + signed / event reminders).
 *
 * **Why this lives outside the individual services**
 *
 * The seeders themselves (`crmEmailTemplates.js`,
 * `contractEmailTemplates.js`, `eventReminderTemplates.js`) are
 * idempotent and module-cached, but they were never called at boot.
 * contractEmailTemplates is called lazily by every contractService
 * send; eventReminderTemplates by the admin email-templates list
 * route. crmEmailTemplates was orphaned — no caller anywhere — so
 * every install that didn't pre-exist its templates failed every
 * quote_sent / invoice_sent / storno_issued send with
 * `Email template '<key>' not found`. The queue processor retries 3
 * times then leaves the row in `status='pending', retry_count=3`,
 * silently dead with no admin surface — exactly the failure flagged
 * in [[feedback_observable_failure_state]] and [[feedback_self_heal_pattern]].
 *
 * Wiring all three into the boot path fixes new installs at first
 * start AND retroactively fixes already-deployed installs whose
 * queue is full of retry-exhausted rows: after we seed the missing
 * template we reset retry_count on rows whose `email_type` matches
 * a key we just inserted, so the queue processor's next tick picks
 * them back up.
 *
 * Safe to call multiple times — each underlying seeder short-
 * circuits after its first successful pass via a module-level flag.
 */

const { ensureCrmEmailTemplatesSeeded } = require('./crmEmailTemplates');
const { ensureContractEmailTemplatesSeeded } = require('./contractEmailTemplates');
const { ensureEventReminderTemplatesSeeded } = require('./eventReminderTemplates');

/**
 * Run all three template seeders, then recover any email_queue rows
 * that exhausted their retries because the template they needed didn't
 * exist yet.
 *
 * @param {object} db      knex instance
 * @param {object} logger  app logger (must expose .info / .warn)
 * @returns {Promise<{ seeded: string[], recovered: number }>}
 *   `seeded` — flat list of template_keys newly inserted across all
 *              three seeders.
 *   `recovered` — count of email_queue rows whose retry_count was
 *                 reset to 0 because their template now exists.
 */
async function seedEmailTemplatesAndRecoverQueue(db, logger) {
  const log = logger || { info: () => {}, warn: () => {} };
  const seeded = [];

  for (const seedFn of [
    ensureCrmEmailTemplatesSeeded,
    ensureContractEmailTemplatesSeeded,
    ensureEventReminderTemplatesSeeded,
  ]) {
    try {
      const inserted = await seedFn(db, log);
      if (Array.isArray(inserted) && inserted.length > 0) {
        seeded.push(...inserted);
      }
    } catch (err) {
      // Boot continues. A missing seed is annoying but not fatal —
      // the lazy callers (where they exist) will retry; admin can
      // re-trigger via the email-templates page. We just log loudly.
      log.warn(`Email template self-heal failed for ${seedFn.name}: ${err.message}`);
    }
  }

  if (seeded.length === 0) return { seeded, recovered: 0 };

  // Recover stuck queue rows. The queue processor caps retries at 3
  // (emailProcessor.processEmailQueue); rows past that are skipped
  // forever. For every template we just inserted, find any pending
  // rows of that email_type whose retries were exhausted and reset
  // them so the processor picks them up on its next tick.
  let recovered = 0;
  if (await db.schema.hasTable('email_queue')) {
    try {
      recovered = await db('email_queue')
        .where('status', 'pending')
        .where('retry_count', '>=', 3)
        .whereIn('email_type', seeded)
        .update({ retry_count: 0, error_message: null });
      if (recovered > 0) {
        log.info(`Recovered ${recovered} email_queue row(s) after self-healing templates: ${seeded.join(', ')}`);
      }
    } catch (err) {
      log.warn(`email_queue recovery skipped after self-heal: ${err.message}`);
    }
  }

  return { seeded, recovered };
}

module.exports = { seedEmailTemplatesAndRecoverQueue };
