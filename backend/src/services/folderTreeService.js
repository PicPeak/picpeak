/**
 * Gallery folder tree (issue 1786).
 *
 * A folder is a `photo_categories` row with `is_folder = true`, scoped to one
 * event, nested through `parent_id` (max MAX_FOLDER_DEPTH levels). A photo
 * lives in a folder through `photos.folder_id`; `photos.category_id` holds
 * filter categories only (migration 265).
 *
 * Every write to the tree goes through here, so the rules live in one place:
 * same event, folders only, no cycles, depth cap, and deleting a folder never
 * deletes or orphans a photo (photos and subfolders move up to the parent).
 *
 * `source_path` is the relative directory a folder was created from
 * ("Saturday/Activity B"). Uploads and external rescans resolve paths against
 * it first, so a folder the admin renamed ("Freitag") still receives the next
 * upload of "Friday".
 */

const { db } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const { formatBoolean, isPostgreSQL } = require('../utils/dbCompat');
const { parseBooleanInput } = require('../utils/parsers');
const { isUniqueViolation } = require('../utils/dbErrors');
const { getAppSetting } = require('../utils/appSettings');
const logger = require('../utils/logger');

const MAX_FOLDER_DEPTH = 3;
const MAX_SEGMENT_LENGTH = 100;
const DEFAULT_FIRST_LOOK_KEYWORDS = ['FirstLook', 'Sneak Peek'];

/**
 * Per-event caps (PR 1826 follow-up). Far above anything a studio builds by
 * hand or exports from Lightroom (a large wedding runs to a few dozen
 * folders); they exist so a scripted client cannot grow one event's tree or
 * request list without bound. Both are checked before the insert, so N
 * writers racing at the limit can overshoot it by up to N-1; every later
 * write is refused. A ceiling, not an exact count.
 */
const FOLDER_LIMITS = Object.freeze({
  MAX_FOLDERS_PER_EVENT: 1000,
  MAX_OPEN_REQUESTS_PER_EVENT: 200,
});

class FolderError extends Error {
  constructor(message, status = 400, code = 'FOLDER_INVALID', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    // Extra fields for the JSON body (e.g. { limit }).
    this.details = details;
  }
}

const folderLimitError = () => new FolderError(
  `This gallery has reached its limit of ${FOLDER_LIMITS.MAX_FOLDERS_PER_EVENT} folders`,
  409,
  'FOLDER_LIMIT_REACHED',
  { limit: FOLDER_LIMITS.MAX_FOLDERS_PER_EVENT },
);

const folderExistsError = (where = 'here') => new FolderError(
  `A folder with this name already exists ${where}`, 409, 'FOLDER_EXISTS',
);

async function countEventFolders(eventId, conn = db) {
  const row = await conn('photo_categories')
    .where({ event_id: eventId })
    .where('is_folder', formatBoolean(true))
    .count('id as count')
    .first();
  return Number(row?.count) || 0;
}

/** Throws FOLDER_LIMIT_REACHED when the event holds its maximum of folders. */
async function assertFolderCapacity(eventId, conn = db) {
  if ((await countEventFolders(eventId, conn)) >= FOLDER_LIMITS.MAX_FOLDERS_PER_EVENT) throw folderLimitError();
}

/**
 * The folder under `parentId` (null = top level) whose name equals `name` the
 * way migration 285's unique index compares it — lower() in SQL — or, failing
 * that, the way the code compares it (JS toLowerCase, which also folds
 * non-ASCII letters SQLite's lower() leaves alone). Used to recover from a
 * unique violation: the row that won the race.
 */
async function findSiblingByName(eventId, parentId, name, conn = db, { excludeId = null } = {}) {
  const scoped = (q) => q
    .where({ event_id: eventId })
    .where('is_folder', formatBoolean(true))
    .modify((b) => { if (parentId == null) b.whereNull('parent_id'); else b.where('parent_id', Number(parentId)); })
    .modify((b) => { if (excludeId != null) b.whereNot('id', Number(excludeId)); });
  const bySql = await scoped(conn('photo_categories')).whereRaw('lower(name) = lower(?)', [name]).first('id', 'name');
  if (bySql) return bySql;
  const lower = String(name).toLowerCase();
  const siblings = await scoped(conn('photo_categories')).select('id', 'name');
  return siblings.find((f) => String(f.name).toLowerCase() === lower) || null;
}

/**
 * One directory name as a folder name: trimmed, whitespace collapsed, capped.
 * Returns null for names that are never folders: empty, `.`/`..`, and hidden
 * entries (`.thumbnails`, `__MACOSX`), which PR 1795's walker skips as well.
 */
function normalizeSegment(raw) {
  if (typeof raw !== 'string') return null;
  // NFC: macOS hands names over decomposed ("Fra\u0308ulein"), Windows
  // composed; without this the same folder name becomes two folders.
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') return null;
  if (name.startsWith('.') || name === '__MACOSX') return null;
  if (/[\\/]/.test(name) || name.includes(String.fromCharCode(0))) return null;
  return name.slice(0, MAX_SEGMENT_LENGTH);
}

/** A directory path (string "a/b" or array) as clean segments. */
function toSegments(dir) {
  const parts = Array.isArray(dir) ? dir : String(dir || '').split(/[\\/]+/);
  const out = [];
  for (const part of parts) {
    const seg = normalizeSegment(part);
    if (seg === null) {
      // A hidden or invalid directory anywhere in the path means the file is
      // not part of the delivery (e.g. ".thumbnails/x.jpg"): drop the path.
      if (typeof part === 'string' && part.trim() !== '') return null;
      continue;
    }
    out.push(seg);
  }
  return out;
}

const pathKey = (segments) => segments.join('/');

/** Letters and digits only, lowercased: "Wedding (First-Look)" → "weddingfirstlook". */
function squash(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * True when a folder name contains one of the keywords (decided: contains, not
 * equals, so "Wedding_FirstLook" and "Wedding (FirstLook)" both count).
 */
function matchesFirstLookKeyword(name, keywords) {
  const hay = squash(name);
  if (!hay) return false;
  return (keywords || []).some((k) => {
    const needle = squash(k);
    return needle.length > 0 && hay.includes(needle);
  });
}

/** Keyword list from Settings → Gallery, or [] when detection is off. */
async function getFirstLookKeywords(conn = db) {
  const enabled = await getAppSetting('first_look_keyword_detection', true, conn);
  if (!parseBooleanInput(enabled, true)) return [];
  const raw = await getAppSetting('first_look_folder_keywords', DEFAULT_FIRST_LOOK_KEYWORDS, conn);
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return list.map((k) => String(k).trim()).filter(Boolean).slice(0, 20);
}

/**
 * Map the directories of one upload (or one import) onto gallery folders.
 *
 * Input: each file's directory relative to the drop/import root, as segments.
 * Rules, in order:
 *   1. A FirstLook keyword is checked on the TOP level only (decided). When
 *      every path sits under one root folder and that root itself matches
 *      ("Wedding_FirstLook/…"), the root is the marker.
 *   2. `skipOuter`: when every path sits under one root folder, that wrapper
 *      level is dropped so guests don't open "Export_2026" first.
 *   3. A keyword folder is a marker, not a folder: its files land in its
 *      parent (the gallery root, since it is top level), flagged first_look,
 *      including anything in subfolders below it.
 *   4. Paths deeper than MAX_FOLDER_DEPTH fold into their level-3 ancestor.
 *
 * Returns { mapped: { [input]: { segments, firstLook } }, singleRoot }, keyed by
 * the input exactly as given (arrays by their joined path). segments is null
 * for a path through a hidden directory: those files are not part of the
 * delivery.
 */
function mapDirectories(dirs, { keywords = [], skipOuter = false } = {}) {
  const cleaned = dirs.map((d) => ({ key: Array.isArray(d) ? pathKey(d) : String(d), segs: toSegments(d) }));
  const nonEmpty = cleaned.filter((c) => c.segs && c.segs.length > 0);
  const roots = new Set(nonEmpty.map((c) => c.segs[0]));
  const singleRoot = nonEmpty.length === cleaned.filter((c) => c.segs).length && roots.size === 1
    ? [...roots][0]
    : null;

  const result = {};
  for (const { key, segs } of cleaned) {
    if (!segs) { result[key] = { segments: null, firstLook: false }; continue; }
    let rest = segs;
    let firstLook = false;
    if (singleRoot && rest.length > 0 && matchesFirstLookKeyword(rest[0], keywords)) {
      firstLook = true;
      rest = [];
    } else {
      if (skipOuter && singleRoot && rest.length > 0) rest = rest.slice(1);
      if (rest.length > 0 && matchesFirstLookKeyword(rest[0], keywords)) {
        firstLook = true;
        rest = [];
      }
    }
    result[key] = { segments: rest.slice(0, MAX_FOLDER_DEPTH), firstLook };
  }
  return { mapped: result, singleRoot };
}

function slugify(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function eventFolders(eventId, conn = db) {
  return conn('photo_categories')
    .where({ event_id: eventId })
    .where('is_folder', formatBoolean(true))
    .select('id', 'name', 'slug', 'parent_id', 'source_path', 'hero_photo_id', 'allow_downloads', 'display_order');
}

function indexById(folders) {
  const byId = new Map();
  folders.forEach((f) => byId.set(Number(f.id), f));
  return byId;
}

/** Depth of a folder (1 = top level). Defensive against a broken cycle. */
function depthOf(folderId, byId) {
  let depth = 0;
  let cur = byId.get(Number(folderId));
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth += 1;
    cur = cur.parent_id ? byId.get(Number(cur.parent_id)) : null;
  }
  return depth;
}

function childrenOf(parentId, folders) {
  const pid = parentId == null ? null : Number(parentId);
  return folders.filter((f) => (f.parent_id == null ? null : Number(f.parent_id)) === pid);
}

/** The folder and every folder below it. */
function subtreeIdsFrom(folderId, folders) {
  const out = [Number(folderId)];
  for (let i = 0; i < out.length; i += 1) {
    childrenOf(out[i], folders).forEach((c) => out.push(Number(c.id)));
  }
  return out;
}

async function subtreeIds(eventId, folderId, conn = db) {
  return subtreeIdsFrom(folderId, await eventFolders(eventId, conn));
}

/** Levels below a folder, the folder itself counted as 1. */
function subtreeHeight(folderId, folders) {
  const kids = childrenOf(folderId, folders);
  if (kids.length === 0) return 1;
  return 1 + Math.max(...kids.map((k) => subtreeHeight(k.id, folders)));
}

/**
 * Folder ids whose photos may not be downloaded: a folder with downloads off
 * and everything below it (decided: inherit, the most restrictive wins).
 */
function blockedFolderIdsFrom(folders) {
  const byId = indexById(folders);
  const blocked = new Set();
  for (const f of folders) {
    let cur = f;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (!parseBooleanInput(cur.allow_downloads, true)) { blocked.add(Number(f.id)); break; }
      cur = cur.parent_id ? byId.get(Number(cur.parent_id)) : null;
    }
  }
  return blocked;
}

async function downloadBlockedFolderIds(eventId, conn = db) {
  return [...blockedFolderIdsFrom(await eventFolders(eventId, conn))];
}

/** knex where-clause: the photo's folder (if any) allows downloads. */
function whereFolderAllowsDownload(blockedIds, column = 'photos.folder_id') {
  return function folderAllows() {
    this.whereNull(column);
    if (blockedIds.length > 0) this.orWhereNotIn(column, blockedIds);
    else this.orWhereNotNull(column);
  };
}

async function uniqueSlug(eventId, base, conn) {
  const root = base || 'folder';
  let candidate = root;
  for (let n = 2; n < 500; n += 1) {
    const clash = await conn('photo_categories').where({ event_id: eventId, slug: candidate }).first('id');
    if (!clash) return candidate;
    candidate = `${root}-${n}`;
  }
  return `${root}-${Date.now()}`;
}

async function nextDisplayOrder(eventId, conn) {
  const row = await conn('photo_categories').where('event_id', eventId).max('display_order as maxOrder').first();
  return (Number(row?.maxOrder) || 0) + 1;
}

/**
 * Insert one folder. Slugs are path-joined ("saturday-activity-b") because
 * UNIQUE(slug, event_id) would otherwise collide between "Activity A" under
 * Friday and under Saturday.
 */
async function insertFolder(eventId, { name, parentId = null, sourcePath = null }, conn = db) {
  const parentSlug = parentId
    ? (await conn('photo_categories').where('id', parentId).first('slug'))?.slug
    : null;
  if (parentId != null && depthOf(parentId, indexById(await eventFolders(eventId, conn))) >= MAX_FOLDER_DEPTH) {
    throw new FolderError(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`, 400, 'FOLDER_TOO_DEEP', { limit: MAX_FOLDER_DEPTH });
  }
  await assertFolderCapacity(eventId, conn);
  const own = slugify(name) || 'folder';
  const base = parentSlug ? `${parentSlug}-${own}`.slice(0, 95) : own.slice(0, 95);
  // The slug is checked, then inserted: two uploads creating different
  // paths that slug alike ("Activity B" / "Activity-B") can collide on
  // UNIQUE(slug, event_id). Such a collision retries with the next suffix;
  // a source_path or sibling-name collision (migration 285) is the caller's
  // to resolve.
  for (let attempt = 0; ; attempt += 1) {
    const slug = await uniqueSlug(eventId, attempt === 0 ? base : `${base}-${attempt + 1}`, conn);
    try {
      const inserted = await guardedWrite(conn, (c) => c('photo_categories').insert({
        name,
        slug,
        is_global: formatBoolean(false),
        event_id: eventId,
        is_folder: formatBoolean(true),
        parent_id: parentId,
        source_path: sourcePath,
        display_order: 0,
      }).returning('id'));
      const id = Number(inserted[0]?.id ?? inserted[0]);
      await conn('photo_categories').where('id', id).update({ display_order: await nextDisplayOrder(eventId, conn) });
      return id;
    } catch (err) {
      const slugTaken = isUniqueViolation(err)
        && !(sourcePath && await conn('photo_categories').where({ event_id: eventId, source_path: sourcePath }).first('id'))
        && !(await findSiblingByName(eventId, parentId, name, conn));
      if (!slugTaken || attempt >= 5) throw err;
    }
  }
}

/**
 * Resolve a folder path to a folder id, creating missing levels when allowed.
 *
 * Each level matches on source_path first, then on the name of an existing
 * sibling (case-insensitive) — that second match is what makes an admin's
 * hand-made "Friday" receive an upload of "Friday/…"; the folder adopts the
 * source path so a later rename keeps matching.
 *
 * Returns { folderId, created: [ids], missingFrom } where:
 *   folderId     the leaf folder, or — when a level is missing and creation
 *                is not allowed — the closest existing ancestor (null = root)
 *   missingFrom  index of the first missing level, or -1 when complete
 */
/**
 * Run a write that may hit a unique violation. Inside a transaction it gets
 * its own savepoint: on Postgres a failed statement aborts the whole
 * transaction, so the recovery read after a lost race would throw too.
 */
const guardedWrite = (conn, fn) => (conn.isTransaction ? conn.transaction((sp) => fn(sp)) : fn(conn));

/**
 * `foldAtLimit`: for unattended ingest (external import, archive restore),
 * where refusing would drop photos. At the folder cap the remaining levels
 * fold into the deepest existing folder instead, logged as a warning, and
 * `limited` is true. Interactive callers leave it off and get the 409.
 */
async function ensurePath(eventId, segments, { canCreate = true, dryRun = false, conn = db, foldAtLimit = false } = {}) {
  // NFC for callers that pass raw names (normalizeSegment does it for paths).
  const segs = (segments || []).slice(0, MAX_FOLDER_DEPTH).map((seg) => String(seg).normalize('NFC'));
  let parentId = null;
  const created = [];
  for (let i = 0; i < segs.length; i += 1) {
    const sourcePath = pathKey(segs.slice(0, i + 1));
    const folders = await eventFolders(eventId, conn);
    let match = folders.find((f) => f.source_path === sourcePath);
    if (!match) {
      const lower = segs[i].toLowerCase();
      match = childrenOf(parentId, folders).find((f) => String(f.name).toLowerCase() === lower);
      if (match && !match.source_path && !dryRun) {
        await guardedWrite(conn, (c) => c('photo_categories').where('id', match.id).update({ source_path: sourcePath }))
          .catch((err) => { if (!isUniqueViolation(err)) throw err; });
      }
    }
    if (match) { parentId = Number(match.id); continue; }
    // A source_path match can sit deeper than its path suggests (an admin
    // moved "A" under two other folders): never create below level 3, fold
    // the rest into the deepest folder allowed instead.
    if (parentId != null && depthOf(parentId, indexById(folders)) >= MAX_FOLDER_DEPTH) {
      return { folderId: parentId, created, missingFrom: -1 };
    }
    if (!canCreate || dryRun) return { folderId: parentId, created, missingFrom: i };
    try {
      const id = await guardedWrite(conn, (c) => insertFolder(eventId, { name: segs[i], parentId, sourcePath }, c));
      created.push(id);
      parentId = id;
    } catch (err) {
      if (foldAtLimit && err instanceof FolderError && err.code === 'FOLDER_LIMIT_REACHED') {
        logger.warn('Folder limit reached; placing photos in the closest existing folder', {
          eventId, path: pathKey(segs), limit: FOLDER_LIMITS.MAX_FOLDERS_PER_EVENT,
        });
        return { folderId: parentId, created, missingFrom: -1, limited: true };
      }
      if (!isUniqueViolation(err)) throw err;
      // A concurrent writer created the same path first (source_path index),
      // or a folder of the same name under this parent (name index, migration
      // 285): use theirs.
      const row = await conn('photo_categories')
        .where({ event_id: eventId, source_path: sourcePath })
        .where('is_folder', formatBoolean(true))
        .first('id')
        || await findSiblingByName(eventId, parentId, segs[i], conn);
      if (!row) throw err;
      parentId = Number(row.id);
    }
  }
  return { folderId: parentId, created, missingFrom: -1 };
}

/** The folder row when it is a folder of this event, else null. */
async function findEventFolder(eventId, folderId, conn = db) {
  if (folderId == null || folderId === '') return null;
  const id = Number(folderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await conn('photo_categories').where({ id, event_id: eventId }).first();
  if (!row || !parseBooleanInput(row.is_folder, false)) return null;
  return row;
}

async function createFolder(eventId, { name, parentId = null }, conn = db) {
  const clean = normalizeSegment(name);
  if (!clean) throw new FolderError('Folder name is required');
  const folders = await eventFolders(eventId, conn);
  if (parentId != null) {
    if (!(await findEventFolder(eventId, parentId, conn))) throw new FolderError('Parent folder not found', 404, 'FOLDER_NOT_FOUND');
    if (depthOf(parentId, indexById(folders)) >= MAX_FOLDER_DEPTH) {
      throw new FolderError(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`, 400, 'FOLDER_TOO_DEEP', { limit: MAX_FOLDER_DEPTH });
    }
  }
  const sibling = childrenOf(parentId, folders).find((f) => String(f.name).toLowerCase() === clean.toLowerCase());
  if (sibling) throw folderExistsError();
  const parent = parentId == null ? null : Number(parentId);
  try {
    return await guardedWrite(conn, (c) => insertFolder(eventId, { name: clean, parentId: parent }, c));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Two creates of the same name racing past the sibling check above: the
    // unique index (migration 285) let one through. Re-read the winner, so the
    // loser gets the same 409 a sequential duplicate gets — and anything else
    // (no such row) still surfaces as the error it is.
    if (await findSiblingByName(eventId, parent, clean, conn)) throw folderExistsError();
    throw err;
  }
}

async function renameFolder(eventId, folderId, name, conn = db) {
  const folder = await findEventFolder(eventId, folderId, conn);
  if (!folder) throw new FolderError('Folder not found', 404, 'FOLDER_NOT_FOUND');
  const clean = normalizeSegment(name);
  if (!clean) throw new FolderError('Folder name is required');
  const folders = await eventFolders(eventId, conn);
  const clash = childrenOf(folder.parent_id, folders)
    .find((f) => Number(f.id) !== Number(folder.id) && String(f.name).toLowerCase() === clean.toLowerCase());
  if (clash) throw new FolderError('A folder with this name already exists here', 409, 'FOLDER_EXISTS');
  // The slug follows the name for readable links; ?folder= resolves on the id,
  // so links shared before the rename keep working. source_path is untouched.
  const parentSlug = folder.parent_id
    ? (await conn('photo_categories').where('id', folder.parent_id).first('slug'))?.slug
    : null;
  const own = slugify(clean) || 'folder';
  const base = (parentSlug ? `${parentSlug}-${own}` : own).slice(0, 95);
  const slug = base === folder.slug ? base : await uniqueSlug(eventId, base, conn);
  try {
    await guardedWrite(conn, (c) => c('photo_categories').where('id', folder.id).update({ name: clean, slug }));
  } catch (err) {
    // A sibling of that name appeared after the check above (migration 285).
    if (isUniqueViolation(err) && await findSiblingByName(eventId, folder.parent_id, clean, conn, { excludeId: folder.id })) {
      throw folderExistsError();
    }
    throw err;
  }
}

async function moveFolder(eventId, folderId, newParentId, conn = db) {
  // Checks and write in one transaction, with the event's folders locked on
  // Postgres (SQLite serialises writers anyway): two crossing moves (A into
  // B, B into A) would otherwise both pass the cycle check and detach the
  // pair from the root.
  if (!conn.isTransaction) return conn.transaction((trx) => moveFolder(eventId, folderId, newParentId, trx));
  if (isPostgreSQL()) await conn('photo_categories').where({ event_id: eventId }).forUpdate().select('id');
  const folder = await findEventFolder(eventId, folderId, conn);
  if (!folder) throw new FolderError('Folder not found', 404, 'FOLDER_NOT_FOUND');
  const folders = await eventFolders(eventId, conn);
  const target = newParentId == null ? null : Number(newParentId);
  if (target != null) {
    if (!(await findEventFolder(eventId, target, conn))) throw new FolderError('Target folder not found', 404, 'FOLDER_NOT_FOUND');
    if (subtreeIdsFrom(folder.id, folders).includes(target)) {
      throw new FolderError('A folder cannot be moved into itself or one of its subfolders', 400, 'FOLDER_CYCLE');
    }
  }
  const targetDepth = target == null ? 0 : depthOf(target, indexById(folders));
  if (targetDepth + subtreeHeight(folder.id, folders) > MAX_FOLDER_DEPTH) {
    throw new FolderError(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`, 400, 'FOLDER_TOO_DEEP', { limit: MAX_FOLDER_DEPTH });
  }
  const clash = childrenOf(target, folders)
    .find((f) => Number(f.id) !== Number(folder.id) && String(f.name).toLowerCase() === String(folder.name).toLowerCase());
  if (clash) throw folderExistsError('there');
  try {
    await guardedWrite(conn, (c) => c('photo_categories').where('id', folder.id).update({ parent_id: target }));
  } catch (err) {
    if (isUniqueViolation(err) && await findSiblingByName(eventId, target, folder.name, conn, { excludeId: folder.id })) {
      throw folderExistsError('there');
    }
    throw err;
  }
}

/**
 * Delete a folder without deleting anything in it: its photos and subfolders
 * move to its parent (or the gallery root), and open folder requests that
 * parked photos here now park them in the parent.
 */
async function deleteFolder(eventId, folderId, conn = db) {
  const folder = await findEventFolder(eventId, folderId, conn);
  if (!folder) throw new FolderError('Folder not found', 404, 'FOLDER_NOT_FOUND');
  const parentId = folder.parent_id == null ? null : Number(folder.parent_id);
  const run = async (trx) => {
    // Same lock as moveFolder, so a move and a delete of the tree serialise.
    if (isPostgreSQL()) await trx('photo_categories').where({ event_id: eventId }).forUpdate().select('id');
    // The subfolders move up a level; one that shares a name with a folder
    // already there would break the sibling-name index (migration 285). Refuse
    // and name it, so the admin renames or moves it first.
    const folders = await eventFolders(eventId, trx);
    const above = new Set(childrenOf(parentId, folders)
      .filter((f) => Number(f.id) !== Number(folder.id))
      .map((f) => String(f.name).toLowerCase()));
    const clash = childrenOf(folder.id, folders).find((f) => above.has(String(f.name).toLowerCase()));
    if (clash) {
      throw new FolderError(
        `The subfolder "${clash.name}" cannot move up: a folder with this name already exists there`,
        409, 'FOLDER_DELETE_NAME_CLASH', { name: clash.name },
      );
    }
    const moved = await trx('photos').where({ event_id: eventId, folder_id: folder.id }).update({ folder_id: parentId });
    // A subfolder may carry the folder's own name (an archive's wrapper
    // folder: Name/Name). The check above rightly treats that name as free,
    // but the row is still there until the delete below: take it out of the
    // sibling-name index (folders only) before its children move up.
    await trx('photo_categories').where('id', folder.id).update({ is_folder: formatBoolean(false) });
    await trx('photo_categories').where({ event_id: eventId, parent_id: folder.id }).update({ parent_id: parentId });
    await trx('folder_requests').where({ event_id: eventId, fallback_folder_id: folder.id }).update({ fallback_folder_id: parentId });
    await trx('event_category_order').where({ category_id: folder.id }).del();
    await trx('photo_categories').where('id', folder.id).del();
    return moved;
  };
  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

/** Move photos into a folder (null = gallery root). Only photos of this event. */
async function movePhotos(eventId, photoIds, folderId, conn = db) {
  const ids = [...new Set((photoIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return 0;
  if (folderId != null && !(await findEventFolder(eventId, folderId, conn))) {
    throw new FolderError('Folder not found', 404, 'FOLDER_NOT_FOUND');
  }
  let moved = 0;
  for (let i = 0; i < ids.length; i += 500) {
    moved += await livePhotos(conn)
      .where('event_id', eventId)
      .whereIn('id', ids.slice(i, i + 500))
      .update({ folder_id: folderId == null ? null : Number(folderId), pending_folder_request_id: null });
  }
  return moved;
}

/** The tree for the admin UI: folders with direct photo counts, ordered. */
async function folderTree(eventId, conn = db) {
  const folders = await eventFolders(eventId, conn);
  const counts = await livePhotos(conn)
    .where('event_id', eventId)
    .whereNotNull('folder_id')
    .groupBy('folder_id')
    .select('folder_id')
    .count('id as count');
  const countBy = new Map(counts.map((c) => [Number(c.folder_id), Number(c.count)]));
  const naturalName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return folders
    .map((f) => ({
      id: Number(f.id),
      name: f.name,
      slug: f.slug,
      parent_id: f.parent_id == null ? null : Number(f.parent_id),
      source_path: f.source_path || null,
      hero_photo_id: f.hero_photo_id || null,
      allow_downloads: parseBooleanInput(f.allow_downloads, true),
      display_order: f.display_order,
      photo_count: countBy.get(Number(f.id)) || 0,
    }))
    // Folders sort naturally by name ("Day 2" before "Day 10"); prefixing
    // names ("01 Ceremony") is how a photographer orders them. Filter
    // categories keep their display_order / per-event override.
    .sort((a, b) => naturalName.compare(a.name, b.name));
}

module.exports = {
  MAX_FOLDER_DEPTH,
  FOLDER_LIMITS,
  DEFAULT_FIRST_LOOK_KEYWORDS,
  FolderError,
  folderExistsError,
  countEventFolders,
  assertFolderCapacity,
  findSiblingByName,
  normalizeSegment,
  toSegments,
  pathKey,
  matchesFirstLookKeyword,
  getFirstLookKeywords,
  mapDirectories,
  eventFolders,
  findEventFolder,
  depthOf,
  indexById,
  subtreeIds,
  subtreeIdsFrom,
  blockedFolderIdsFrom,
  downloadBlockedFolderIds,
  whereFolderAllowsDownload,
  ensurePath,
  createFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
  movePhotos,
  folderTree,
};
