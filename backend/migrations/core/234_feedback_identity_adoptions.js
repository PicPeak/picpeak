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
 * A feedback_identity_adoptions row records that adoption was attempted
 * for a given cookie subject in a given event (whether or not a matching
 * legacy row was found), so the gate can be "has adoption been attempted
 * for this subject here" instead of "is this cookie brand new" — and so it
 * still runs exactly once per subject and event, not on every request
 * forever. Keyed per event because the cookie (path /api/gallery) spans
 * every gallery, while the legacy sha256(ip:userAgent) hash names none: a
 * claim on the subject alone would adopt the first event visited and skip
 * every other one.
 *
 * The composite primary key doubles as the concurrency claim: two racing
 * requests for the same subject and event both try to INSERT it, and only
 * one wins. The claim is written inside the re-key transaction, so a
 * rolled-back re-key leaves no claim behind.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('feedback_identity_adoptions')) return;
  await knex.schema.createTable('feedback_identity_adoptions', (table) => {
    table.string('subject', 32).notNullable();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.timestamp('adopted_at').notNullable();
    table.primary(['subject', 'event_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('feedback_identity_adoptions');
};
