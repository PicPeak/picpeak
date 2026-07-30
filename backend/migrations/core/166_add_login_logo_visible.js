/**
 * Migration 166: per-event toggle to hide the branding logo on the
 * gallery password page (#894).
 *
 * NULL (the default) keeps today's behaviour — the global branding logo is
 * shown above the password form. Only an explicit `false` hides it for
 * that gallery; the admin login page and other surfaces are unaffected.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasColumn('events', 'login_logo_visible')) return;
  await knex.schema.alterTable('events', (t) => {
    t.boolean('login_logo_visible').nullable();
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasColumn('events', 'login_logo_visible'))) return;
  await knex.schema.alterTable('events', (t) => {
    t.dropColumn('login_logo_visible');
  });
};
