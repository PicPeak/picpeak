/**
 * Why a photo cannot be served right now (issue 2121).
 *
 * An external (NAS) photo whose file is gone from the share after a complete
 * scan is not deleted: the share may come back, and the admin decides. The
 * scan sets this to 'source_missing', which keeps the photo from every
 * gallery viewer (the gallery list, counts, downloads and archives) while the
 * admin still sees it, and clears it when the file is back. A column of its
 * own rather than visibility = 'hidden': that is the admin's choice (and PIN
 * clients still see it), and a returning file must not undo it. NULL on every
 * photo that can be served.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  const has = await knex.schema.hasColumn('photos', 'unavailable_reason');
  if (!has) {
    await knex.schema.alterTable('photos', (t) => {
      t.string('unavailable_reason', 32).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  const has = await knex.schema.hasColumn('photos', 'unavailable_reason');
  if (has) {
    await knex.schema.alterTable('photos', (t) => {
      t.dropColumn('unavailable_reason');
    });
  }
};
