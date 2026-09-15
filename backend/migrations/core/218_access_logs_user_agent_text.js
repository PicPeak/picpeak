/**
 * Migration 218: store the full user agent in access_logs (#1501).
 *
 * initializeDatabase() created access_logs.user_agent with string(), which is
 * varchar(255) on PostgreSQL. In-app browsers send longer user agents —
 * Instagram on Android and Facebook Messenger on iOS both exceed 255 — so the
 * insert threw and every route that logs access answered 500 for them,
 * starting with the gallery login ("Verification failed").
 *
 * PostgreSQL only: SQLite does not enforce a varchar length. varchar -> text is
 * binary-coercible, so the ALTER rewrites no rows, and re-running it is a
 * no-op. down() is intentionally empty: narrowing back to 255 fails as soon as
 * a longer user agent is stored, and would bring the bug back.
 */
exports.up = async function (knex) {
  const client = (knex.client.config.client || '').toLowerCase();
  if (client !== 'pg' && client !== 'postgresql') return;
  if (!(await knex.schema.hasTable('access_logs'))) return;
  if (!(await knex.schema.hasColumn('access_logs', 'user_agent'))) return;
  await knex.raw('ALTER TABLE access_logs ALTER COLUMN user_agent TYPE text');
};

exports.down = async function () {};
