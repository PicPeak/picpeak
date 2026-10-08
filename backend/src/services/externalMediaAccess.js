const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { parseBoolean } = require('../utils/dbCompat');
const { safePathJoin, assertRealpathUnder } = require('../utils/fileSecurityUtils');

class ExternalMediaAccessError extends Error {
  constructor(message = 'External media access denied', statusCode = 403) {
    super(message);
    this.name = 'ExternalMediaAccessError';
    this.statusCode = statusCode;
  }
}

function normalizeSourcePath(value) {
  if (typeof value !== 'string' || value.length > 1024
    || value.startsWith('/') || /[\\\\:]/.test(value)
    || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new ExternalMediaAccessError('Invalid external media path', 400);
  }
  const segments = value.trim().split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new ExternalMediaAccessError('Invalid external media path', 400);
  }
  return segments.join('/');
}

const contains = (base, candidate) => candidate === base || candidate.startsWith(base + '/');
const rootPath = () => require('./externalMediaService').getExternalMediaRoot();

async function assertCanonicalTarget(target) {
  const root = rootPath();
  try {
    const canonicalRoot = await fs.realpath(root);
    const canonicalTarget = await fs.realpath(target);
    if (path.relative(path.resolve(root), path.resolve(target)) !== path.relative(canonicalRoot, canonicalTarget)) {
      const error = new Error('Invalid external media path');
      error.code = 'PATH_OUTSIDE_BASE';
      throw error;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
}

// Never trust roleName supplied by an HTTP body, service options or a scheduler.
async function principal(adminId, permission) {
  if (!Number.isSafeInteger(Number(adminId)) || Number(adminId) <= 0) throw new ExternalMediaAccessError();
  const admin = await db('admin_users').leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', Number(adminId)).select('admin_users.id', 'admin_users.is_active', 'admin_users.role_id', 'roles.name as roleName').first();
  if (!admin || !parseBoolean(admin.is_active)) throw new ExternalMediaAccessError();
  if (admin.roleName !== 'super_admin' && permission) {
    const granted = await db('role_permissions').join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('role_permissions.role_id', admin.role_id).where('permissions.name', permission).first('permissions.id');
    if (!granted) throw new ExternalMediaAccessError();
  }
  return admin;
}

async function ownedSources(admin) {
  return db('external_media_sources').where('owner_id', admin.id).orderBy('path').select('id', 'path', 'owner_id');
}

async function authorizeSource(adminId, value, permission = 'photos.view') {
  const admin = await principal(adminId, permission);
  const relativePath = normalizeSourcePath(value);
  const root = rootPath();
  const target = safePathJoin(root, relativePath);
  let source = null;
  if (admin.roleName !== 'super_admin') {
    source = (await ownedSources(admin)).find((row) => contains(row.path, relativePath));
    if (!source) throw new ExternalMediaAccessError();
  }
  const sourceRoot = source ? safePathJoin(root, source.path) : root;
  await assertRealpathUnder(root, sourceRoot);
  if (source && path.relative(await fs.realpath(root), await fs.realpath(sourceRoot)).split(path.sep).join('/') !== source.path) {
    throw new ExternalMediaAccessError();
  }
  await assertRealpathUnder(sourceRoot, target);
  await assertCanonicalTarget(target);
  return { admin, relativePath, target, sourceRoot, sourceId: source?.id ?? null };
}

async function authorizeImport(eventId, value, { actor = null, automatic = false, permission = 'photos.upload' } = {}) {
  const event = await db('events').where('id', eventId).first();
  if (!event) throw new ExternalMediaAccessError('Event not found', 404);
  // A system watcher is a deputy for the current owner, never a global root.
  const adminId = automatic ? event.created_by : (actor?.type === 'admin' ? actor.id : null);
  const admin = await principal(adminId, permission);
  if (admin.roleName !== 'super_admin' && Number(event.created_by) !== Number(admin.id)) {
    throw new ExternalMediaAccessError();
  }
  const access = await authorizeSource(admin.id, value, permission);
  return { ...access, event };
}

async function authorizeSelectedFile(access, filePath) {
  await assertRealpathUnder(access.sourceRoot, filePath);
  await assertCanonicalTarget(filePath);
}

async function listSources(adminId) {
  const admin = await principal(adminId);
  return admin.roleName === 'super_admin'
    ? db('external_media_sources').orderBy('path').select('id', 'path', 'owner_id')
    : ownedSources(admin);
}

async function assignSource(adminId, value, ownerId) {
  const admin = await principal(adminId);
  if (admin.roleName !== 'super_admin') throw new ExternalMediaAccessError();
  const relativePath = normalizeSourcePath(value);
  if (!relativePath) throw new ExternalMediaAccessError('Choose a source subfolder, not the global root', 400);
  if (ownerId !== null && (!Number.isSafeInteger(ownerId) || ownerId <= 0)) {
    throw new ExternalMediaAccessError('Invalid source owner', 400);
  }
  if (ownerId !== null) await principal(ownerId);
  const root = rootPath();
  const target = safePathJoin(root, relativePath);
  await assertRealpathUnder(root, target);
  // A symlink alias must not turn the same physical folder into two owners.
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  if (path.relative(realRoot, realTarget).split(path.sep).join('/') !== relativePath
    || !(await fs.stat(target)).isDirectory()) {
    throw new ExternalMediaAccessError('Source must be a real directory, not a symlink alias', 400);
  }
  return db.transaction(async (trx) => {
    // One database row serializes assignments across replicas, on both engines.
    await trx('external_media_source_lock').insert({ id: 1, revision: 0 }).onConflict('id').ignore();
    await trx('external_media_source_lock').where({ id: 1 }).increment('revision', 1);
    const rows = await trx('external_media_sources').select('id', 'path');
    if (rows.some((row) => row.path !== relativePath && (contains(row.path, relativePath) || contains(relativePath, row.path)))) {
      throw new ExternalMediaAccessError('Source folders must not overlap', 409);
    }
    await trx('external_media_sources').insert({ path: relativePath, owner_id: ownerId })
      .onConflict('path').merge({ owner_id: ownerId });
    return trx('external_media_sources').where({ path: relativePath }).first('id', 'path', 'owner_id');
  });
}

async function revokeSource(adminId, sourceId) {
  const admin = await principal(adminId);
  if (admin.roleName !== 'super_admin') throw new ExternalMediaAccessError();
  return db.transaction(async (trx) => {
    await trx('external_media_source_lock').insert({ id: 1, revision: 0 }).onConflict('id').ignore();
    await trx('external_media_source_lock').where({ id: 1 }).increment('revision', 1);
    return trx('external_media_sources').where({ id: sourceId }).del();
  });
}

async function ownerChoices(adminId) {
  const admin = await principal(adminId);
  if (admin.roleName !== 'super_admin') return [];
  const { formatBoolean } = require('../utils/dbCompat');
  return db('admin_users').where('is_active', formatBoolean(true)).orderBy('username').select('id', 'username');
}

module.exports = {
  ExternalMediaAccessError, normalizeSourcePath, principal, ownedSources, authorizeSource,
  authorizeImport, authorizeSelectedFile, listSources, assignSource, revokeSource, ownerChoices,
};
