/**
 * Migration 285: one folder per name among its siblings (PR 1826 review,
 * concern 5).
 *
 * folderTreeService refuses a second "Friday" next to an existing "friday"
 * (sibling names compare case-insensitively), but only in code: two creates
 * of the same name under the same parent that race past the check could both
 * insert. This index makes the database the last word:
 *
 *   UNIQUE (event_id, coalesce(parent_id, 0), lower(name))
 *     WHERE is_folder AND event_id IS NOT NULL
 *
 *   coalesce   top-level folders have parent_id NULL, and NULLs never collide
 *              in a unique index; 0 is never a real id.
 *   lower()    the same case-insensitive rule the code applies. On SQLite it
 *              folds ASCII only, so "Ärger"/"ärger" are still caught by the
 *              code alone there; the index is the backstop, not the rule.
 *   WHERE      folders only: filter categories and global categories keep
 *              their own rules (UNIQUE(slug, event_id)).
 *
 * Existing duplicates are swept first so the index can be created on an
 * install that already has some: the oldest folder (lowest id) keeps its
 * name, every later one is renamed "Name (2)", "Name (3)", … — nothing moves,
 * so no photo, subfolder, source_path or link changes place. The admin can
 * merge them afterwards (move photos, delete the empty one).
 *
 * The sweep groups by the index's own expression, so whatever the index would
 * reject is exactly what gets renamed.
 *
 * Raw SQL with a per-engine boolean literal on purpose: the knex builder
 * cannot express an index on expressions with a WHERE clause.
 */

const INDEX_NAME = 'photo_categories_folder_sibling_name_uq';
const MAX_NAME_LENGTH = 100;

const isPg = (knex) => String(knex.client.config.client || '').toLowerCase().includes('pg')
  || String(knex.client.config.client || '').toLowerCase().includes('postgres');

const folderPredicate = (knex) => `is_folder = ${isPg(knex) ? 'true' : '1'} AND event_id IS NOT NULL`;

async function hasSchema(knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return false;
  for (const col of ['is_folder', 'parent_id', 'event_id', 'name']) {
    if (!(await knex.schema.hasColumn('photo_categories', col))) return false;
  }
  return true;
}

/** "Name (n)", the base cut so the result stays within the name column. */
function suffixed(name, n) {
  const tail = ` (${n})`;
  return `${String(name).slice(0, MAX_NAME_LENGTH - tail.length)}${tail}`;
}

async function sweepDuplicates(knex) {
  const where = folderPredicate(knex);
  const groups = await knex.raw(
    `SELECT event_id, coalesce(parent_id, 0) AS parent_key, lower(name) AS name_key
       FROM photo_categories
      WHERE ${where}
      GROUP BY event_id, coalesce(parent_id, 0), lower(name)
     HAVING count(*) > 1`
  );
  const rows = Array.isArray(groups) ? groups : groups.rows;
  let renamed = 0;
  for (const group of rows) {
    const members = await knex('photo_categories')
      .whereRaw(where)
      .where('event_id', group.event_id)
      .whereRaw('coalesce(parent_id, 0) = ?', [group.parent_key])
      .whereRaw('lower(name) = ?', [group.name_key])
      .orderBy('id', 'asc')
      .select('id', 'name');
    // The oldest keeps its name; the rest take the first free "(n)".
    for (const member of members.slice(1)) {
      for (let n = 2; ; n += 1) {
        const candidate = suffixed(member.name, n);
        const taken = await knex('photo_categories')
          .whereRaw(where)
          .where('event_id', group.event_id)
          .whereRaw('coalesce(parent_id, 0) = ?', [group.parent_key])
          .whereRaw('lower(name) = lower(?)', [candidate])
          .first('id');
        if (!taken) {
          await knex('photo_categories').where('id', member.id).update({ name: candidate });
          renamed += 1;
          break;
        }
      }
    }
  }
  return renamed;
}

exports.up = async function (knex) {
  if (!(await hasSchema(knex))) return;
  await sweepDuplicates(knex);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} `
    + `ON photo_categories (event_id, (coalesce(parent_id, 0)), (lower(name))) WHERE ${folderPredicate(knex)}`
  );
};

exports.down = async function (knex) {
  // The renames of the sweep stay: they are valid names either way.
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
};

exports.sweepDuplicates = sweepDuplicates;
exports.INDEX_NAME = INDEX_NAME;
