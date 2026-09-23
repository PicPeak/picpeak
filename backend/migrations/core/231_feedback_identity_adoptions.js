/**
 * Migration 231: one-time-adoption marker for legacy feedback identities
 * (issue 1584 follow-up).
 *
 * anonymousFeedbackIdentifier() only attempted the legacy-identity re-key
 * when it was also minting a brand-new cookie (isNewIdentity). Guests who
 * had already picked up a valid `picpeak_feedback` cookie between #1571
 * (which shipped the cookie) and #1584 shipping (which added the re-key)
 * never got adopted — isNewIdentity is false forever once their cookie
 * exists, so the migration silently skipped exactly the cohort it targets.
 *
 * feedback_identity_adoptions.subject records that adoption was attempted
 * for a given cookie subject (whether or not a matching legacy row was
 * found), so the gate can be "has adoption been attempted for this
 * subject" instead of "is this cookie brand new" — and so it still runs
 * exactly once per subject, not on every request forever.
 *
 * The primary key doubles as the concurrency claim: two racing requests
 * for the same subject both try to INSERT it, and only one wins.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('feedback_identity_adoptions')) return;
  await knex.schema.createTable('feedback_identity_adoptions', (table) => {
    table.string('subject', 32).primary();
    table.timestamp('adopted_at').notNullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('feedback_identity_adoptions');
};
