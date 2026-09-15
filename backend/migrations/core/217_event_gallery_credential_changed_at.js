/**
 * Migration 217: when a gallery credential last changed.
 *
 * A gallery session is a 24-hour JWT opened with the gallery password, the
 * client password or the client link. Changing one of those only rewrote the
 * stored hash or link, so a guest who got in before the change kept access for
 * the rest of the token's lifetime. `gallery_password_changed_at` and
 * `client_password_changed_at` record the moment of the change; the gallery
 * access check rejects sessions of that access level issued before it.
 *
 * Additive and idempotent: two nullable columns, each guarded by hasColumn.
 * Existing events keep NULL, which means "never changed" and cuts nothing off.
 */
const COLUMNS = ['gallery_password_changed_at', 'client_password_changed_at'];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn('events', column))) {
      await knex.schema.alterTable('events', (t) => {
        t.timestamp(column).nullable();
      });
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('events', column)) {
      await knex.schema.alterTable('events', (t) => {
        t.dropColumn(column);
      });
    }
  }
};
