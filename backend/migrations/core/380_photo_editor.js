/**
 * Issue 2619: a non-destructive basic photo editor in the admin.
 *
 * photos.edit_params is the edit as a small JSON parameter set (see
 * src/utils/photoEditMath.js); NULL is no edit. The original file is never
 * rewritten. edit_rev counts saves (an edit, a batch copy and a reset each
 * add one) and rides in guest image URLs, so a browser fetches the new image;
 * edit_applied_rev is the revision whose renditions are in place. A row with
 * edit_rev > edit_applied_rev is the background queue (photoEdits.js), so a
 * restart picks up where it stopped.
 *
 * edit_render_path is the full-size edited JPEG guests download, a cache
 * rendered from the original and the params (rebuilt when it is missing);
 * edit_width / edit_height its size, which guests are shown. photos.width /
 * height stay the original's: face boxes are in its pixels.
 *
 * edit_applied_params / edit_applied_width / edit_applied_height /
 * edit_applied_render_path are the edit, size and render of the applied
 * revision, the one guests' previews and thumbnails show: while a newer save
 * is being applied (or failed), renditions are cut from that render and face
 * boxes placed with that edit, so URL, pixels and boxes move together.
 *
 * edit_failed_rev is the revision the background apply last failed on, and
 * edit_error a short code for what failed ('render', 'renditions', 'error'),
 * on the row so every replica reports the failure and a retry on any replica
 * clears it. A failure counts only while it names the current edit_rev.
 *
 * photo_feedback.annotation_geometry is the geometry of the edit applied
 * when a guest drew on the photo (null: the unedited original), so the
 * drawing is moved onto the photo as an edit turns or crops it later.
 *
 * photo_edit_presets are the studio's saved edits, shared by every admin.
 * feature_flags.photoEditor gates the editor, default off.
 *
 * Additive only; down() drops what up() added.
 */
exports.up = async function up(knex) {
  const columns = [
    ['edit_params', (t) => t.text('edit_params').nullable()],
    ['edit_rev', (t) => t.integer('edit_rev').notNullable().defaultTo(0)],
    ['edit_applied_rev', (t) => t.integer('edit_applied_rev').notNullable().defaultTo(0)],
    ['edit_render_path', (t) => t.string('edit_render_path', 512).nullable()],
    ['edit_width', (t) => t.integer('edit_width').nullable()],
    ['edit_height', (t) => t.integer('edit_height').nullable()],
    ['edit_applied_params', (t) => t.text('edit_applied_params').nullable()],
    ['edit_applied_width', (t) => t.integer('edit_applied_width').nullable()],
    ['edit_applied_height', (t) => t.integer('edit_applied_height').nullable()],
    ['edit_applied_render_path', (t) => t.string('edit_applied_render_path', 512).nullable()],
    ['edit_failed_rev', (t) => t.integer('edit_failed_rev').nullable()],
    ['edit_error', (t) => t.string('edit_error', 32).nullable()],
  ];
  const hasPhotos = await knex.schema.hasTable('photos');
  for (const [name, add] of columns) {
    if (hasPhotos && !(await knex.schema.hasColumn('photos', name))) {
      await knex.schema.alterTable('photos', add);
    }
  }
  if (await knex.schema.hasTable('photo_feedback') && !(await knex.schema.hasColumn('photo_feedback', 'annotation_geometry'))) {
    await knex.schema.alterTable('photo_feedback', (t) => t.text('annotation_geometry').nullable());
  }
  if (!(await knex.schema.hasTable('photo_edit_presets'))) {
    await knex.schema.createTable('photo_edit_presets', (t) => {
      t.increments('id').primary();
      t.string('name', 80).notNullable();
      t.text('params').notNullable();
      t.integer('created_by_admin_id').nullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }
  if (await knex.schema.hasTable('feature_flags')) {
    const flag = await knex('feature_flags').where({ key: 'photoEditor' }).first();
    if (!flag) await knex('feature_flags').insert({ key: 'photoEditor', value: false });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'photoEditor' }).del();
  }
  await knex.schema.dropTableIfExists('photo_edit_presets');
  if (await knex.schema.hasTable('photo_feedback') && await knex.schema.hasColumn('photo_feedback', 'annotation_geometry')) {
    await knex.schema.alterTable('photo_feedback', (t) => t.dropColumn('annotation_geometry'));
  }
  const hasPhotos = await knex.schema.hasTable('photos');
  for (const name of ['edit_error', 'edit_failed_rev', 'edit_applied_render_path', 'edit_applied_height', 'edit_applied_width', 'edit_applied_params', 'edit_height', 'edit_width', 'edit_render_path', 'edit_applied_rev', 'edit_rev', 'edit_params']) {
    if (hasPhotos && await knex.schema.hasColumn('photos', name)) {
      await knex.schema.alterTable('photos', (t) => t.dropColumn(name));
    }
  }
};
