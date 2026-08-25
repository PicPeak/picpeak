/**
 * Fold each event's base path into its external photo rows (#1163).
 *
 * photos.external_relpath used to be stored relative to events.external_path —
 * a column every import overwrites — so importing a second folder into an
 * event rebased every photo already in it. Root-relative paths make a row
 * self-describing.
 *
 * This lives in a service rather than inside migration 187 because it has two
 * callers. The migration is one. The other is a .picpeak restore: knex_migrations
 * is excluded from the archive, so restoring a pre-#1163 backup onto an
 * already-migrated instance drops base-relative rows into a schema that no
 * longer folds them, and every original in the restored library becomes
 * unreachable with nothing logged.
 *
 * REPAIR, and its limits. For a healthy event the correct new value is just
 * `external_path + relpath` — that is what the app resolves today, so folding
 * it in changes nothing and can break nothing. For an event that has ALREADY
 * been rebased, that same rule would bake the broken path in permanently, so
 * where the current resolution does not exist on disk this walks up the base
 * path looking for an ancestor under which the file IS there (the shape the
 * bug produces: a parent imported first, a child second). A row it cannot
 * place is left resolving exactly where it resolves today — preserving current
 * behaviour is the floor, never guess below it.
 *
 * The probe is skipped entirely when the media root is unreachable or empty:
 * an unmounted share makes every file look missing, and "repairing" off that
 * signal would move every original on a healthy install. When it does run it
 * is one access() per photo, base path first, so a healthy install pays one
 * stat per row and then a single UPDATE per event.
 *
 * Idempotency is recorded explicitly in app_settings rather than inferred from
 * the data. The tempting inference — "does the relpath already start with the
 * base path?" — is wrong for any event with a subfolder named after its parent
 * (base 'Trip', row 'Trip/x.jpg'), and being wrong there corrupts a path in an
 * operation that has no undo.
 */

const path = require('path');
const fsp = require('fs').promises;

const MARKER = 'external_relpath_root_relative';

function normalizeBase(externalPath) {
  return String(externalPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** Every prefix of `base`, longest first, then '' (the root itself). */
function ancestorPrefixes(base) {
  const segs = base.split('/').filter(Boolean);
  const out = [];
  for (let i = segs.length; i > 0; i--) out.push(segs.slice(0, i).join('/'));
  out.push('');
  return out;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Joined without the safePathJoin the app serves through: this is reading, and
 * a stored path that escapes the root is damage worth detecting rather than
 * throwing on.
 */
const under = (root, ...parts) => path.join(root, ...parts.filter(Boolean));

async function rootUsable(root) {
  if (!root) return false;
  try {
    // An unmounted NFS/SMB share usually leaves the mountpoint behind as an
    // ordinary empty directory, so readdir succeeds on storage that is gone.
    return (await fsp.readdir(root)).length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {import('knex')} knex
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{skipped?: string, folded?: number, repaired?: number, stranded?: number, collided?: number}>}
 */
async function foldExternalRelpaths(knex, log = () => {}) {
  if (!(await knex.schema.hasTable('photos'))) return { skipped: 'no photos table' };
  if (!(await knex.schema.hasColumn('photos', 'external_relpath'))) return { skipped: 'no external_relpath column' };
  if (!(await knex.schema.hasTable('events'))) return { skipped: 'no events table' };
  if (!(await knex.schema.hasTable('app_settings'))) return { skipped: 'no app_settings table' };

  if (await knex('app_settings').where('setting_key', MARKER).first()) {
    return { skipped: 'already folded' };
  }

  const events = await knex('events').select('id', 'external_path');
  const byId = new Map(events.map((e) => [e.id, normalizeBase(e.external_path)]));
  const eventRows = await knex('photos').whereNotNull('external_relpath').distinct('event_id');

  let root = null;
  try {
    root = require('./externalMediaService').getExternalMediaRoot();
  } catch (e) {
    log(`media root unavailable (${e.message}) — folding without on-disk repair`);
  }
  const canProbe = await rootUsable(root);
  if (!canProbe) log('media root unreachable or empty — folding base paths in without on-disk repair');

  let folded = 0; let repaired = 0; let stranded = 0; let collided = 0;

  for (const { event_id: eventId } of eventRows) {
    // No base path means the rows are already relative to the root.
    const base = byId.get(eventId);
    if (!base) continue;

    const rows = await knex('photos')
      .where('event_id', eventId)
      .whereNotNull('external_relpath')
      .select('id', 'external_relpath');

    // Deciding health from a SAMPLE was the tempting shortcut and it is not
    // safe: a rebased event whose first few rows happen to come from the most
    // recent import reads as healthy, and every older row is baked in wrong.
    const prefixes = ancestorPrefixes(base);
    const placements = [];
    let allUnderBase = true;

    for (const row of rows) {
      if (!canProbe) { placements.push([row, base]); continue; }
      let chosen = null;
      for (const prefix of prefixes) {
        if (await exists(under(root, prefix, row.external_relpath))) { chosen = prefix; break; }
      }
      if (chosen === null) { chosen = base; stranded++; }
      if (chosen !== base) allUnderBase = false;
      placements.push([row, chosen]);
    }

    if (allUnderBase) {
      // One statement, and it cannot collide: every row gains the same prefix,
      // so distinct values stay distinct.
      folded += await knex('photos')
        .where('event_id', eventId)
        .whereNotNull('external_relpath')
        .update({ external_relpath: knex.raw('? || external_relpath', [`${base}/`]) });
      continue;
    }

    for (const [row, chosen] of placements) {
      if (chosen === base) folded++; else repaired++;
      const next = chosen ? `${chosen}/${row.external_relpath}` : row.external_relpath;
      try {
        await knex('photos').where('id', row.id).update({ external_relpath: next });
      } catch (e) {
        // Two rows can land on the same path — the same file imported under two
        // different bases really is one file, and migration 186's unique index
        // says so. Leaving the loser untouched is the conservative half of
        // that: it stays a row pointing somewhere, rather than being deleted.
        collided++;
      }
    }
  }

  await knex('app_settings').insert({
    setting_key: MARKER,
    setting_value: JSON.stringify(true),
    setting_type: 'system',
    updated_at: new Date().toISOString(),
  });

  log(`${folded} folded, ${repaired} repaired, ${stranded} left unresolved, ${collided} skipped as duplicates`);
  return { folded, repaired, stranded, collided };
}

module.exports = { foldExternalRelpaths, MARKER };
