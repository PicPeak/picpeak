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
 * Existence alone is NOT enough to accept an ancestor. A row whose file an
 * admin simply deleted would otherwise adopt any same-named file further up —
 * base `Trip/Sub`, relpath `photo.jpg`, an unrelated `Trip/photo.jpg` — and
 * downloads would then serve the WRONG original, which is worse than a broken
 * link. So an ancestor candidate must also match photos.size_bytes, recorded
 * by the import from the very file the row describes. Rows carrying no size
 * are never repaired from an ancestor.
 *
 * ATOMICITY. Probing is read-only and runs first; every rewrite and the marker
 * are then committed in ONE transaction. Split across commits, a process
 * killed mid-fold would leave converted and unconverted rows behind with no
 * marker, and the next run would fold the converted ones a second time —
 * putting every original one directory deeper, permanently.
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
const { deleteDuplicatePhotos } = require('./externalPhotoDedupe');

const MARKER = 'external_relpath_root_relative';
// Per-row parking value for the two-pass rewrite below. Unique by id, and
// prefixed with a byte no real relative path starts with, so a crash between
// the passes leaves something obviously wrong rather than something plausible.
const STAGING_PREFIX = '\u0000fold-staging/';
const CHUNK = 400; // SQLite caps a statement at 999 bound parameters.
const chunk = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
};

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
 * Is `p` plausibly the file this row was imported from?
 *
 * Size is the provenance signal available without re-reading every original:
 * photos.size_bytes was written by the import from the file the row describes.
 * Returns false when it cannot be verified, so an unverifiable candidate is
 * never adopted from somewhere the row did not previously point.
 */
async function fileMatchesSize(p, expectedSize) {
  if (expectedSize == null || Number(expectedSize) <= 0) return false;
  try {
    const stats = await fsp.stat(p);
    return stats.isFile() && stats.size === Number(expectedSize);
  } catch {
    return false;
  }
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
 * @param {import('knex')} knex  a knex instance, or a transaction from a caller
 *   that is already inside one (the restore).
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

  // ---- Phase 1: decide, writing nothing. -------------------------------
  // Read-only, so the transaction below stays short. Probing a cold NAS can
  // take minutes and holding a write transaction open for that would block the
  // app for the duration.
  let folded = 0; let repaired = 0; let stranded = 0; let collided = 0;
  const plan = [];

  for (const { event_id: eventId } of eventRows) {
    // No base path means the rows are already relative to the root.
    const base = byId.get(eventId);
    if (!base) continue;

    const rows = await knex('photos')
      .where('event_id', eventId)
      .whereNotNull('external_relpath')
      .select('id', 'external_relpath', 'size_bytes');

    // Deciding health from a SAMPLE was the tempting shortcut and it is not
    // safe: a rebased event whose first few rows happen to come from the most
    // recent import reads as healthy, and every older row is baked in wrong.
    const prefixes = ancestorPrefixes(base);
    const placements = [];
    let allUnderBase = true;

    for (const row of rows) {
      if (!canProbe) { placements.push([row, base]); continue; }

      let chosen = null;
      // The current base first, on existence alone — nothing is inferred
      // there, it is where the row already resolves.
      if (await exists(under(root, base, row.external_relpath))) {
        chosen = base;
      } else {
        // Anywhere else has to prove itself: the name AND the size the import
        // recorded. Without that a row whose file an admin deleted would adopt
        // an unrelated same-named file one directory up, and downloads would
        // serve the wrong original.
        for (const prefix of prefixes) {
          if (prefix === base) continue;
          if (await fileMatchesSize(under(root, prefix, row.external_relpath), row.size_bytes)) {
            chosen = prefix;
            break;
          }
        }
      }

      if (chosen === null) { chosen = base; stranded++; }
      if (chosen !== base) allUnderBase = false;
      placements.push([row, chosen]);
    }

    if (allUnderBase) {
      folded += rows.length;
      plan.push({ eventId, base, bulk: true, rows: [], ids: rows.map((r) => r.id) });
      continue;
    }

    // Two rows can now target the same path — the same file imported under two
    // different bases really is one file. Resolved HERE rather than by letting
    // the write fail: a caught write error cannot tell a genuine duplicate from
    // a lock or I/O fault, and continuing past one would certify a partial
    // conversion by writing the marker anyway.
    //
    // The loser is DELETED, not skipped. Skipping leaves it holding a
    // base-relative path that the root-only resolver then reads as
    // `<root>/<relpath>` — permanently pointing at the wrong place, or
    // nowhere, with the marker saying the conversion is done. And it is a
    // duplicate by construction: two rows that resolve to one file is exactly
    // what migration 186 removes, so it goes through the same helper, which
    // reparents the feedback and marks and reconciles the face clusters.
    const claimed = new Map();
    const resolved = [];
    const losers = new Map();
    for (const [row, chosen] of placements) {
      const next = chosen ? `${chosen}/${row.external_relpath}` : row.external_relpath;
      const winner = claimed.get(next);
      if (winner != null) { losers.set(row.id, winner); collided++; continue; }
      claimed.set(next, row.id);
      if (chosen === base) folded++; else repaired++;
      resolved.push([row.id, next]);
    }
    plan.push({ eventId, base, bulk: false, rows: resolved, losers });
  }

  // ---- Phase 2: write, all or nothing. ---------------------------------
  // The marker rides in the same transaction as the rewrites, so there is no
  // window where some rows are folded, the marker is absent, and a second run
  // folds them again — which would put every original one directory deeper,
  // permanently.
  const apply = async (trx) => {
    for (const step of plan) {
      if (step.bulk) {
        // BY ID, not by event. Phase 1 runs outside the transaction and can
        // take minutes probing a cold mount; an import completing in that
        // window inserts an already root-relative row, and `where event_id`
        // would prefix it a second time with the stale base.
        for (const ids of chunk(step.ids)) {
          await trx('photos')
            .whereIn('id', ids)
            .whereNotNull('external_relpath')
            .update({ external_relpath: trx.raw('? || external_relpath', [`${step.base}/`]) });
        }
        continue;
      }
      // Losers first: while they still hold their old path, the survivor has
      // not taken the value they would collide with.
      if (step.losers && step.losers.size) {
        await deleteDuplicatePhotos(trx, step.losers);
      }

      // Two passes, through a per-row temporary value. The FINAL values are
      // all distinct, but a final value can equal another row's CURRENT one —
      // `photo.jpg` repairing to `Trip/photo.jpg` while the existing
      // `Trip/photo.jpg` is still waiting to fold — so a single pass violates
      // migration 186's unique index halfway through. And on Postgres that
      // surfaces as 23505, which run-migrations-safe.js mistakes for "schema
      // already exists" and records the migration as applied after the
      // rollback, leaving every path unconverted with no retry.
      for (const [id] of step.rows) {
        await trx('photos').where('id', id).update({ external_relpath: `${STAGING_PREFIX}${id}` });
      }
      for (const [id, next] of step.rows) {
        // No catch: collisions were resolved above, so anything failing here is
        // a real fault and must roll the whole fold back rather than leave a
        // half-converted table certified by the marker.
        await trx('photos').where('id', id).update({ external_relpath: next });
      }
    }

    await trx('app_settings').insert({
      setting_key: MARKER,
      setting_value: JSON.stringify(true),
      setting_type: 'system',
      updated_at: new Date().toISOString(),
    });
  };

  // A caller already inside a transaction (the restore) passes its trx in as
  // `knex`; opening a nested one would deadlock SQLite.
  if (knex.isTransaction) await apply(knex);
  else await knex.transaction(apply);

  log(`${folded} folded, ${repaired} repaired, ${stranded} left unresolved, ${collided} skipped as duplicates`);
  return { folded, repaired, stranded, collided };
}


module.exports = { foldExternalRelpaths, MARKER };
