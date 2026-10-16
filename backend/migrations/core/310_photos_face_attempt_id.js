/**
 * Migration 310: one id per face-scan claim (issue 2069).
 *
 * `face_attempt_id` names one claim of a photo by the face queue, as
 * `tag_attempt_id` does for scene tags (migration 297). A scan's result is
 * committed only while the row still carries the id of the claim that
 * produced it. `face_status = 'processing'` alone cannot tell a purge
 * followed by a new claim from the original claim, so a scan of the old
 * bytes could publish its faces over the new picture.
 *
 * Cleared whenever the face services take the row out of 'processing', and
 * every claim writes a fresh one, so a value left behind elsewhere matches
 * nothing. Nothing to backfill: a row a worker held across the upgrade has
 * no id, its worker is gone with the restart, and the janitor returns it to
 * 'pending'.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (await knex.schema.hasColumn('photos', 'face_attempt_id')) return;
  await knex.schema.alterTable('photos', (t) => {
    t.string('face_attempt_id', 36).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'face_attempt_id'))) return;
  await knex.schema.alterTable('photos', (t) => {
    t.dropColumn('face_attempt_id');
  });
};
