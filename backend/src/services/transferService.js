/**
 * transferService — PicTransfer (#997).
 *
 * A "transfer" is a share link that bundles ORIGINAL photos picked from any
 * number of events and hands them to a recipient as a download link. It can
 * also open a short (6-char) upload token so the client can send files back
 * (logos etc.).
 *
 * Design decisions (from the issue):
 *   - Downloads always serve ORIGINAL files, never watermarked — a transfer is
 *     a deliberate hand-off, not a preview.
 *   - The ZIP is built on demand by replicating the gallery download-selected
 *     loop (resolvePhotoStorageKey → storage.get → archiver), generalised to
 *     span multiple events. No pre-generation / caching.
 *   - The link is simply disabled after `expires_at`; an optional max-downloads
 *     cap can disable it earlier. Files are kept `grace_days` days past disable
 *     (retention), then the cleanup sweep hard-deletes them.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { pipeStreamToResponse } = require('../utils/streamResponse');
const { formatBoolean } = require('../utils/dbCompat');
const { getAppSetting } = require('../utils/appSettings');
const { getStorage } = require('./storage');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { getUseOriginalFilenames, getZipEntryNames } = require('./downloadFilenameService');
const { sanitizeForZipEntry } = require('../utils/filenameSanitizer');
const { filterOwnedEventIds } = require('../middleware/ownership');

// Unambiguous alphabet for the client upload token — no 0/O/1/I/L to keep it
// easy to read aloud / type from an email. 31 characters, so 10 of them give
// about 49.6 bits; the 6-character codes issued before (about 29.7 bits)
// stay valid, the route accepts 4 to 16. Guessing is further slowed by the
// per-route rate limiter and the per-network lockout on the upload endpoint.
const UPLOAD_TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const UPLOAD_TOKEN_LENGTH = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

async function getFrontendUrl() {
  const { getAbsoluteFrontendUrl } = require('../utils/frontendUrl');
  return getAbsoluteFrontendUrl();
}

function generateDownloadToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
}

function generateUploadTokenCandidate(length = UPLOAD_TOKEN_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // crypto.randomInt is unbiased over [0, len); a plain byte % len would
    // over-represent the first (256 % len) characters of the alphabet.
    out += UPLOAD_TOKEN_ALPHABET[crypto.randomInt(0, UPLOAD_TOKEN_ALPHABET.length)];
  }
  return out;
}

/**
 * Return the subset of `photoIds` whose event the admin may act on. Mirrors the
 * event-ownership rule used everywhere else (super_admin unrestricted; others
 * get events they created plus ownerless legacy events) so a scoped admin can
 * never bundle — and then hand out via a public token — originals from an event
 * they don't own. Foreign and non-existent ids are both dropped.
 */
async function filterOwnedPhotoIds(admin, photoIds) {
  const ids = [...new Set((photoIds || []).map((n) => parseInt(n, 10)).filter(Boolean))];
  if (!ids.length) return [];
  const photos = await db('photos').whereIn('id', ids).select('id', 'event_id');
  const eventIds = [...new Set(photos.map((p) => p.event_id))];
  if (!eventIds.length) return [];
  const { allowed } = await filterOwnedEventIds(admin, eventIds);
  const allowedEvents = new Set(allowed.map(Number));
  return photos.filter((p) => allowedEvents.has(Number(p.event_id))).map((p) => p.id);
}

async function generateUniqueUploadToken(conn = db) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generateUploadTokenCandidate();
    const clash = await conn('transfers').where({ upload_token: candidate }).first('id');
    if (!clash) return candidate;
  }
  // Astronomically unlikely; fall back to a longer token so we never loop,
  // still within the 16 characters the public route accepts.
  return generateUploadTokenCandidate(UPLOAD_TOKEN_LENGTH + 4);
}

/** Storage-relative directory that holds a transfer's client uploads. */
function uploadDirKey(transferId) {
  return path.posix.join('uploads/transfers', String(transferId));
}

/**
 * Storage-relative directory for the admin's own deliverable files — the files
 * dropped straight into a transfer at creation (transfer_extra_files), as
 * opposed to the gallery photos it references or the client's return uploads.
 */
function extraFilesDirKey(transferId) {
  return path.posix.join('transfers', String(transferId), 'files');
}

/**
 * Derive the recipient-facing/admin status of a transfer row.
 * Never mutates — the cron sweep is what actually flips is_active/deleted_at.
 */
function computeStatus(transfer) {
  if (transfer.deleted_at) return 'deleted';
  const now = Date.now();
  const expired = !transfer.is_active
    || (transfer.expires_at && new Date(transfer.expires_at).getTime() <= now);
  if (expired) return 'expired';
  return 'active';
}

function downloadsRemaining(transfer) {
  const cap = Number(transfer.max_downloads) || 0;
  if (cap <= 0) return null; // unlimited
  return Math.max(0, cap - (Number(transfer.download_count) || 0));
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

async function createTransfer(input, admin) {
  const adminId = admin && admin.id ? admin.id : null;
  const {
    title = '',
    message = null,
    expiresInDays,
    maxDownloads,
    graceDays,
    allowUploads = false,
    uploadExpiresInDays,
    photoIds = [],
    deliveryMethod = 'link',
  } = input || {};

  const defaultExpiry = await getAppSetting('transfer_default_expiry_days', 14);
  const defaultGrace = await getAppSetting('transfer_default_grace_days', 7);
  const defaultMax = await getAppSetting('transfer_default_max_downloads', 0);

  const expiryDays = Number.isFinite(Number(expiresInDays)) && Number(expiresInDays) > 0
    ? Number(expiresInDays) : Number(defaultExpiry) || 14;
  const grace = Number.isFinite(Number(graceDays)) && Number(graceDays) >= 0
    ? Number(graceDays) : Number(defaultGrace) || 7;
  const cap = Number.isFinite(Number(maxDownloads)) && Number(maxDownloads) > 0
    ? Number(maxDownloads) : (Number(defaultMax) > 0 ? Number(defaultMax) : null);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiryDays * DAY_MS);

  const row = {
    token: generateDownloadToken(),
    title: String(title || '').slice(0, 255),
    message: message || null,
    created_by: adminId || null,
    expires_at: expiresAt,
    max_downloads: cap,
    download_count: 0,
    is_active: formatBoolean(true),
    grace_days: grace,
    allow_uploads: formatBoolean(!!allowUploads),
    delivery_method: deliveryMethod === 'email' ? 'email' : 'link',
    created_at: now,
    updated_at: now,
  };

  if (allowUploads) {
    row.upload_token = await generateUniqueUploadToken();
    const uploadDays = Number.isFinite(Number(uploadExpiresInDays)) && Number(uploadExpiresInDays) > 0
      ? Number(uploadExpiresInDays) : expiryDays;
    row.upload_expires_at = new Date(now.getTime() + uploadDays * DAY_MS);
  }

  const [id] = await db('transfers').insert(row).returning('id');
  const transferId = typeof id === 'object' && id !== null ? id.id : id;

  if (Array.isArray(photoIds) && photoIds.length) {
    await addFiles(transferId, photoIds, admin);
  }

  return getTransfer(transferId);
}

async function listTransfers({ search = '', admin } = {}) {
  let query = db('transfers').whereNull('deleted_at');

  // Non-super_admins only see their own transfers (plus ownerless legacy rows).
  // Otherwise the list — which used to carry each transfer's download token —
  // handed every admin a public link to everyone else's originals.
  if (admin && admin.roleName !== 'super_admin') {
    query = query.where((q) => q.whereNull('created_by').orWhere('created_by', admin.id));
  }
  if (search) {
    query = query.where('title', 'like', `%${search}%`);
  }
  query = query.orderBy('created_at', 'desc');

  const rows = await query;
  const ids = rows.map((r) => r.id);

  // File + upload counts in two grouped queries rather than N+1.
  const fileCounts = ids.length
    ? await db('transfer_files').whereIn('transfer_id', ids)
      .select('transfer_id').count('* as count').groupBy('transfer_id')
    : [];
  const uploadCounts = ids.length
    ? await db('transfer_uploads').whereIn('transfer_id', ids)
      .select('transfer_id').count('* as count').groupBy('transfer_id')
    : [];
  // Admin-uploaded deliverable files count toward file_count alongside photos.
  const extraCounts = ids.length
    ? await db('transfer_extra_files').whereIn('transfer_id', ids)
      .select('transfer_id').count('* as count').groupBy('transfer_id')
    : [];
  const fileCountMap = new Map(fileCounts.map((r) => [r.transfer_id, Number(r.count)]));
  const uploadCountMap = new Map(uploadCounts.map((r) => [r.transfer_id, Number(r.count)]));
  const extraCountMap = new Map(extraCounts.map((r) => [r.transfer_id, Number(r.count)]));

  return rows.map((r) => {
    // The list view never needs the secrets — a row is a summary, and the
    // recipient/upload links live on the detail response. Strip them so the
    // list can't be used to read another (or one's own, over-broadly) token.
    const safe = serializeTransfer(r);
    delete safe.token;
    delete safe.upload_token;
    delete safe.download_url;
    delete safe.upload_url;
    safe.file_count = (fileCountMap.get(r.id) || 0) + (extraCountMap.get(r.id) || 0);
    safe.upload_count = uploadCountMap.get(r.id) || 0;
    return safe;
  });
}

function serializeTransfer(row) {
  return {
    id: row.id,
    token: row.token,
    title: row.title,
    message: row.message,
    created_by: row.created_by,
    expires_at: row.expires_at,
    max_downloads: row.max_downloads || null,
    download_count: row.download_count || 0,
    downloads_remaining: downloadsRemaining(row),
    is_active: row.is_active === true || row.is_active === 1,
    disabled_at: row.disabled_at || null,
    grace_days: row.grace_days,
    deleted_at: row.deleted_at || null,
    allow_uploads: row.allow_uploads === true || row.allow_uploads === 1,
    delivery_method: row.delivery_method === 'email' ? 'email' : 'link',
    upload_token: row.upload_token || null,
    upload_expires_at: row.upload_expires_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: computeStatus(row),
    download_url: `/transfer/${row.token}`,
    upload_url: row.upload_token ? `/transfer-upload/${row.upload_token}` : null,
  };
}

/** Full detail: transfer + its files (with photo/event info) + client uploads. */
async function getTransfer(id) {
  const row = await db('transfers').where({ id }).first();
  if (!row) return null;

  const files = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .join('events', 'events.id', 'photos.event_id')
    .where('transfer_files.transfer_id', id)
    .orderBy('transfer_files.sort_order', 'asc')
    .orderBy('transfer_files.id', 'asc')
    .select(
      'transfer_files.id as file_id',
      'transfer_files.sort_order',
      'photos.id as photo_id',
      'photos.filename',
      'photos.original_filename',
      'photos.type',
      'photos.size_bytes',
      'photos.event_id',
      'events.event_name',
      'events.slug as event_slug',
    );

  const uploads = await db('transfer_uploads')
    .where('transfer_id', id)
    .orderBy('uploaded_at', 'desc')
    .select('id', 'original_filename', 'size_bytes', 'mime_type', 'uploader_ip', 'uploaded_at');

  // Admin-uploaded deliverable files (no photo/event — the operator's own bytes).
  const extraFiles = await db('transfer_extra_files')
    .where('transfer_id', id)
    .orderBy('sort_order', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'original_filename', 'size_bytes', 'mime_type', 'created_at');

  const recipients = await db('transfer_recipients')
    .where('transfer_id', id)
    .orderBy('id', 'asc')
    .select('id', 'email', 'last_sent_at');

  return {
    ...serializeTransfer(row),
    file_count: files.length + extraFiles.length,
    upload_count: uploads.length,
    extra_files: extraFiles.map((f) => ({
      id: f.id,
      filename: f.original_filename,
      size_bytes: f.size_bytes,
      mime_type: f.mime_type,
    })),
    recipients: recipients.map((r) => ({ id: r.id, email: r.email, last_sent_at: r.last_sent_at || null })),
    files: files.map((f) => ({
      file_id: f.file_id,
      photo_id: f.photo_id,
      filename: f.original_filename || f.filename,
      type: f.type,
      size_bytes: f.size_bytes,
      event_id: f.event_id,
      event_name: f.event_name,
      event_slug: f.event_slug,
      // Admin picker previews thumbnails via the existing admin photo endpoint.
      thumbnail_url: `/admin/photos/${f.event_id}/thumbnail/${f.photo_id}`,
    })),
    uploads,
  };
}

/** Minimal row for the ownership guard: { id, created_by } or undefined. */
async function getTransferOwner(id) {
  return db('transfers').where({ id }).whereNull('deleted_at').first('id', 'created_by');
}

async function updateTransfer(id, fields) {
  const row = await db('transfers').where({ id }).first();
  if (!row) return null;

  const update = { updated_at: new Date() };
  if (fields.title !== undefined) update.title = String(fields.title || '').slice(0, 255);
  if (fields.message !== undefined) update.message = fields.message || null;
  if (fields.maxDownloads !== undefined) {
    const cap = Number(fields.maxDownloads);
    update.max_downloads = Number.isFinite(cap) && cap > 0 ? cap : null;
  }
  if (fields.graceDays !== undefined) {
    const grace = Number(fields.graceDays);
    if (Number.isFinite(grace) && grace >= 0) update.grace_days = grace;
  }
  if (fields.expiresAt !== undefined) {
    update.expires_at = new Date(fields.expiresAt);
  } else if (fields.expiresInDays !== undefined) {
    const days = Number(fields.expiresInDays);
    if (Number.isFinite(days) && days > 0) {
      update.expires_at = new Date(Date.now() + days * DAY_MS);
    }
  }
  if (fields.isActive !== undefined) {
    update.is_active = formatBoolean(!!fields.isActive);
    // Re-activating clears the retention clock; disabling starts it.
    if (fields.isActive) {
      update.disabled_at = null;
      update.admin_notified_at = null;
    } else if (!row.disabled_at) {
      update.disabled_at = new Date();
    }
  }

  await db('transfers').where({ id }).update(update);
  return getTransfer(id);
}

async function deleteTransfer(id) {
  const row = await db('transfers').where({ id }).first();
  if (!row) return false;
  await removeUploadedFiles(id);
  await removeExtraFiles(id);
  // transfer_files / transfer_uploads / transfer_downloads / transfer_extra_files
  // / transfer_recipients cascade on the FK, but we delete explicitly too so the
  // feature works even where SQLite FK enforcement is off.
  await db('transfer_files').where({ transfer_id: id }).del();
  await db('transfer_uploads').where({ transfer_id: id }).del();
  await db('transfer_downloads').where({ transfer_id: id }).del();
  await db('transfer_extra_files').where({ transfer_id: id }).del();
  await db('transfer_recipients').where({ transfer_id: id }).del();
  await db('transfers').where({ id }).del();
  return true;
}

async function addFiles(transferId, photoIds, admin) {
  const ids = [...new Set((photoIds || []).map((n) => parseInt(n, 10)).filter(Boolean))];
  if (!ids.length) return getTransfer(transferId);

  // Only photos whose event the caller owns (ownership implies existence).
  // Without this a scoped admin could bundle any event's originals and hand
  // them out through the public download token — every ownership control
  // bypassed. Mirrors the GHSA-wrg5 fix pattern.
  const ownedIds = await filterOwnedPhotoIds(admin, ids);
  const validIds = new Set(ownedIds);

  // Skip photos already attached (the unique index would reject them anyway).
  const already = await db('transfer_files')
    .where('transfer_id', transferId)
    .whereIn('photo_id', ids)
    .select('photo_id');
  const alreadySet = new Set(already.map((r) => r.photo_id));

  const maxOrderRow = await db('transfer_files')
    .where('transfer_id', transferId)
    .max('sort_order as max')
    .first();
  let order = (maxOrderRow && Number(maxOrderRow.max)) || 0;

  const rows = ids
    .filter((pid) => validIds.has(pid) && !alreadySet.has(pid))
    .map((pid) => {
      order += 1;
      return { transfer_id: transferId, photo_id: pid, sort_order: order, created_at: new Date() };
    });

  if (rows.length) {
    await db('transfer_files').insert(rows);
    await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  }
  return getTransfer(transferId);
}

async function removeFile(transferId, fileId) {
  await db('transfer_files').where({ id: fileId, transfer_id: transferId }).del();
  await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  return getTransfer(transferId);
}

async function enableUploads(transferId, { uploadExpiresInDays } = {}) {
  const row = await db('transfers').where({ id: transferId }).first();
  if (!row) return null;
  const now = new Date();
  const days = Number.isFinite(Number(uploadExpiresInDays)) && Number(uploadExpiresInDays) > 0
    ? Number(uploadExpiresInDays)
    : Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / DAY_MS));
  const update = {
    allow_uploads: formatBoolean(true),
    upload_token: row.upload_token || (await generateUniqueUploadToken()),
    upload_expires_at: new Date(now.getTime() + days * DAY_MS),
    updated_at: now,
  };
  await db('transfers').where({ id: transferId }).update(update);
  return getTransfer(transferId);
}

async function disableUploads(transferId) {
  await db('transfers').where({ id: transferId }).update({
    allow_uploads: formatBoolean(false),
    upload_token: null,
    upload_expires_at: null,
    updated_at: new Date(),
  });
  return getTransfer(transferId);
}

// ---------------------------------------------------------------------------
// Public lookups (token-authenticated)
// ---------------------------------------------------------------------------

async function getTransferByToken(token) {
  return db('transfers').where({ token }).whereNull('deleted_at').first();
}

async function getTransferByUploadToken(uploadToken) {
  return db('transfers').where({ upload_token: uploadToken }).whereNull('deleted_at').first();
}

/**
 * Recipient-facing projection — filenames + sizes only. The download page has
 * NO thumbnails by design, so we deliberately don't expose any image URLs.
 */
async function getPublicView(transfer) {
  const files = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .where('transfer_files.transfer_id', transfer.id)
    .orderBy('transfer_files.sort_order', 'asc')
    .orderBy('transfer_files.id', 'asc')
    .select(
      'transfer_files.id as file_id',
      'photos.filename',
      'photos.original_filename',
      'photos.size_bytes',
    );

  const extraFiles = await db('transfer_extra_files')
    .where('transfer_id', transfer.id)
    .orderBy('sort_order', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'original_filename', 'size_bytes');

  const useOriginal = await getUseOriginalFilenames();
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size_bytes) || 0), 0)
    + extraFiles.reduce((sum, f) => sum + (Number(f.size_bytes) || 0), 0);

  // Public file ids are prefixed so the single-file route knows which table to
  // read: `p<id>` = a referenced gallery photo, `x<id>` = an admin-uploaded file.
  const photoEntries = files.map((f) => ({
    file_id: `p${f.file_id}`,
    filename: (useOriginal && f.original_filename) ? f.original_filename : f.filename,
    size_bytes: f.size_bytes || null,
  }));
  const extraEntries = extraFiles.map((f) => ({
    file_id: `x${f.id}`,
    filename: f.original_filename,
    size_bytes: f.size_bytes || null,
  }));

  return {
    title: transfer.title || 'Transfer',
    message: transfer.message || null,
    expires_at: transfer.expires_at,
    file_count: files.length + extraFiles.length,
    total_bytes: totalBytes,
    downloads_remaining: downloadsRemaining(transfer),
    files: [...photoEntries, ...extraEntries],
  };
}

/**
 * Whether a transfer can currently be downloaded. Returns a reason code so the
 * route can map it to a clean 403/410.
 */
function assertDownloadable(transfer) {
  if (!transfer || transfer.deleted_at) return { ok: false, code: 'NOT_FOUND', status: 404 };
  const isActive = transfer.is_active === true || transfer.is_active === 1;
  if (!isActive) return { ok: false, code: 'TRANSFER_DISABLED', status: 410 };
  if (transfer.expires_at && new Date(transfer.expires_at).getTime() <= Date.now()) {
    return { ok: false, code: 'TRANSFER_EXPIRED', status: 410 };
  }
  const remaining = downloadsRemaining(transfer);
  if (remaining !== null && remaining <= 0) {
    return { ok: false, code: 'DOWNLOAD_LIMIT_REACHED', status: 410 };
  }
  return { ok: true };
}

/**
 * Claim one download before anything is streamed. The count and the cap are
 * compared in the same UPDATE, so concurrent requests cannot all pass a cap
 * they read from the same snapshot. Returns false when the link is disabled or
 * its cap is used up; the caller answers 410 without streaming. A claimed
 * download counts even if the client disconnects mid-stream, which is the
 * "disable after N downloads" intent.
 */
async function claimDownload(transfer, { kind = 'all', photoId = null, ip = null } = {}) {
  const claimed = await db('transfers')
    .where({ id: transfer.id, is_active: formatBoolean(true) })
    .whereNull('deleted_at')
    .andWhere((q) => q.whereNull('max_downloads')
      .orWhere('max_downloads', '<=', 0)
      .orWhere('download_count', '<', db.ref('max_downloads')))
    .increment('download_count', 1);
  if (!claimed) return false;
  await db('transfer_downloads').insert({
    transfer_id: transfer.id,
    kind,
    photo_id: photoId,
    ip,
    downloaded_at: new Date(),
  });

  const cap = Number(transfer.max_downloads) || 0;
  if (cap > 0) {
    // Evaluate the cap against the freshly-incremented persisted count, not the
    // stale in-memory `transfer.download_count` — two concurrent downloads
    // reading the same snapshot would otherwise both think they're under the
    // cap and blow past it. The disable is idempotent, so a double-trip here is
    // harmless.
    const fresh = await db('transfers').where({ id: transfer.id })
      .first('download_count', 'is_active');
    const count = Number(fresh && fresh.download_count) || 0;
    const stillActive = fresh && (fresh.is_active === true || fresh.is_active === 1);
    if (count >= cap && stillActive) {
      // Cap reached — disable and start the retention clock.
      await db('transfers').where({ id: transfer.id }).update({
        is_active: formatBoolean(false),
        disabled_at: new Date(),
        updated_at: new Date(),
      });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// ZIP building — cross-event, originals only
// ---------------------------------------------------------------------------

/** Load the ordered photos for a transfer, each joined to its event. */
async function loadTransferPhotos(transferId) {
  const rows = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .join('events', 'events.id', 'photos.event_id')
    .where('transfer_files.transfer_id', transferId)
    .orderBy('transfer_files.sort_order', 'asc')
    .orderBy('transfer_files.id', 'asc')
    .select(
      'photos.*',
      'events.slug as event_slug',
      'events.event_name as event_name',
      'events.source_mode as event_source_mode',
      'events.external_path as event_external_path',
    );
  return rows;
}

/**
 * Stream a ZIP of a transfer's ORIGINAL files to `res`. Mirrors the gallery
 * download-selected loop but spans events: each photo carries its own event
 * fields (aliased above) so the resolver gets the right event. Photos are
 * grouped into per-event subfolders to keep same-named files apart.
 *
 * Returns the number of files successfully appended.
 */
async function streamTransferArchive(transfer, res) {
  const photos = await loadTransferPhotos(transfer.id);

  const archiveName = `${sanitizeForZipEntry(transfer.title || 'transfer') || 'transfer'}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    logger.error('transferService: archive error', { transferId: transfer.id, error: err.message });
    try { res.destroy(err); } catch (_) { /* noop */ }
  });
  archive.pipe(res);

  const storage = getStorage();
  const useOriginal = await getUseOriginalFilenames();
  const entryNames = getZipEntryNames(photos, useOriginal);
  const multiEvent = new Set(photos.map((p) => p.event_id)).size > 1;

  let appended = 0;
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const event = {
      id: photo.event_id,
      slug: photo.event_slug,
      source_mode: photo.event_source_mode,
      external_path: photo.event_external_path,
    };
    let name = entryNames[i] || `photo-${photo.id}.jpg`;
    // Only foldered when the transfer actually spans multiple events, so a
    // single-event transfer stays flat.
    if (multiEvent) {
      const folder = sanitizeForZipEntry(photo.event_name || photo.event_slug || `event-${photo.event_id}`);
      name = `${folder}/${name}`;
    }
    try {
      const storageKey = resolvePhotoStorageKey(event, photo);
      if (storageKey && storage.kind() === 'local') {
        const srcStat = await storage.stat(storageKey);
        if (!srcStat) throw new Error(`Photo missing in storage: ${storageKey}`);
      } else if (!storageKey && !fs.existsSync(resolvePhotoFilePath(event, photo))) {
        throw new Error('Photo file missing on disk');
      }

      if (storageKey) {
        const stream = await storage.get(storageKey);
        archive.append(stream, { name });
      } else {
        archive.file(resolvePhotoFilePath(event, photo), { name });
      }
      appended += 1;
    } catch (err) {
      logger.warn('transferService: skipping photo in transfer archive', {
        transferId: transfer.id, photoId: photo.id, error: err.message,
      });
    }
  }

  // Admin-uploaded deliverable files. Foldered under files/ only when the
  // transfer also spans multiple events, to match the photo foldering above.
  const extraFiles = await loadTransferExtraFiles(transfer.id);
  const usedNames = new Set();
  for (const extra of extraFiles) {
    let base = sanitizeForZipEntry(extra.original_filename) || `file-${extra.id}`;
    if (usedNames.has(base)) base = `${extra.id}-${base}`; // keep same-named uploads apart
    usedNames.add(base);
    const name = multiEvent ? `files/${base}` : base;
    try {
      const srcStat = storage.kind() === 'local' ? await storage.stat(extra.stored_path) : true;
      if (!srcStat) throw new Error(`Extra file missing in storage: ${extra.stored_path}`);
      const stream = await storage.get(extra.stored_path);
      archive.append(stream, { name });
      appended += 1;
    } catch (err) {
      logger.warn('transferService: skipping extra file in transfer archive', {
        transferId: transfer.id, extraId: extra.id, error: err.message,
      });
    }
  }

  await archive.finalize();
  return appended;
}

/** Load the admin-uploaded deliverable files for a transfer, in order. */
async function loadTransferExtraFiles(transferId) {
  return db('transfer_extra_files')
    .where('transfer_id', transferId)
    .orderBy('sort_order', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'original_filename', 'stored_path', 'size_bytes', 'mime_type');
}

/**
 * Stream a single ORIGINAL file from a transfer to `res`. Returns false when
 * the file id isn't part of this transfer or the bytes are missing.
 */
/**
 * Run the caller's pre-stream check (the download claim) for a source that is
 * already open. A refused claim or a claim that throws (a failed DB write)
 * closes the source, so it never holds a file descriptor or S3 connection.
 */
async function allowStream(beforeStream, openStream) {
  if (!beforeStream) return true;
  const close = () => {
    if (openStream && typeof openStream.destroy === 'function') openStream.destroy();
  };
  let allowed;
  try {
    allowed = await beforeStream();
  } catch (err) {
    close();
    throw err;
  }
  if (!allowed) close();
  return Boolean(allowed);
}

async function streamTransferFile(transfer, rawFileId, res, { beforeStream = null } = {}) {
  // Public file ids are prefixed (see getPublicView): `p<id>` = referenced
  // gallery photo, `x<id>` = admin-uploaded file. Tolerate a bare number as a
  // photo id for safety.
  const idStr = String(rawFileId || '');
  const prefix = /^[a-z]/i.test(idStr) ? idStr[0].toLowerCase() : 'p';
  const numId = parseInt(/^[a-z]/i.test(idStr) ? idStr.slice(1) : idStr, 10);
  if (!Number.isFinite(numId) || numId <= 0) return false;

  if (prefix === 'x') {
    return streamTransferExtraFile(transfer, numId, res, { beforeStream });
  }

  const row = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .join('events', 'events.id', 'photos.event_id')
    .where('transfer_files.transfer_id', transfer.id)
    .where('transfer_files.id', numId)
    .select(
      'photos.*',
      'events.slug as event_slug',
      'events.source_mode as event_source_mode',
      'events.external_path as event_external_path',
    )
    .first();
  if (!row) return false;

  const event = {
    id: row.event_id,
    slug: row.event_slug,
    source_mode: row.event_source_mode,
    external_path: row.event_external_path,
  };
  const useOriginal = await getUseOriginalFilenames();
  const [name] = getZipEntryNames([row], useOriginal);
  const filename = name || row.filename || `photo-${row.id}.jpg`;

  // Resolve + verify the source exists BEFORE writing any response header, so a
  // missing file yields a clean 404 rather than a truncated 200. The joined row
  // carries photos.* (path / source_origin / external_relpath), so it is a
  // valid photo object for the resolver as-is.
  const storage = getStorage();
  const storageKey = resolvePhotoStorageKey(event, row);
  let source; // { type: 'stream' | 'file', value }
  if (storageKey) {
    if (storage.kind() === 'local') {
      const srcStat = await storage.stat(storageKey);
      if (!srcStat) return false;
    }
    source = { type: 'stream', value: await storage.get(storageKey) };
  } else {
    const abs = resolvePhotoFilePath(event, row);
    if (!fs.existsSync(abs)) return false;
    source = { type: 'file', value: abs };
  }
  // The file exists: let the caller claim the download before any byte goes
  // out. A refused claim leaves the response untouched.
  if (!(await allowStream(beforeStream, source.type === 'stream' ? source.value : null))) return false;

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  // Through the helper, never a bare pipe: the local read stream opens lazily
  // and an S3 body can drop mid-transfer, and a source 'error' with no
  // listener is an uncaught throw that ends the process. This route is
  // public, so that would be an unauthenticated crash.
  const body = source.type === 'stream' ? source.value : fs.createReadStream(source.value);
  pipeStreamToResponse(body, res, { context: `transfer ${transfer.id} photo ${row.id}` });
  return true;
}

/** Stream a single admin-uploaded deliverable file from storage to `res`. */
async function streamTransferExtraFile(transfer, extraId, res, { beforeStream = null } = {}) {
  const row = await db('transfer_extra_files')
    .where({ id: extraId, transfer_id: transfer.id })
    .first();
  if (!row) return false;

  const storage = getStorage();
  if (storage.kind() === 'local') {
    const srcStat = await storage.stat(row.stored_path);
    if (!srcStat) return false;
  }
  const stream = await storage.get(row.stored_path);
  if (!(await allowStream(beforeStream, stream))) return false;
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.original_filename)}"`);
  pipeStreamToResponse(stream, res, { context: `transfer ${transfer.id} extra file ${row.id}` });
  return true;
}

// ---------------------------------------------------------------------------
// Admin-uploaded deliverable files
// ---------------------------------------------------------------------------

/** Record an admin-uploaded deliverable file (bytes already written to storage). */
async function addExtraFile(transferId, { originalFilename, storedPath, sizeBytes, mimeType }) {
  const maxOrderRow = await db('transfer_extra_files')
    .where('transfer_id', transferId)
    .max('sort_order as max')
    .first();
  const order = ((maxOrderRow && Number(maxOrderRow.max)) || 0) + 1;
  const [id] = await db('transfer_extra_files').insert({
    transfer_id: transferId,
    original_filename: String(originalFilename || 'file').slice(0, 512),
    stored_path: storedPath,
    size_bytes: sizeBytes || null,
    mime_type: mimeType || null,
    sort_order: order,
    created_at: new Date(),
  }).returning('id');
  await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  return typeof id === 'object' && id !== null ? id.id : id;
}

/** Remove one admin-uploaded deliverable file (row + bytes). */
async function removeExtraFile(transferId, extraId) {
  const row = await db('transfer_extra_files').where({ id: extraId, transfer_id: transferId }).first();
  if (!row) return getTransfer(transferId);
  try {
    await getStorage().delete(row.stored_path);
  } catch (err) {
    logger.warn('transferService: failed to delete extra file', {
      transferId, path: row.stored_path, error: err.message,
    });
  }
  await db('transfer_extra_files').where({ id: extraId, transfer_id: transferId }).del();
  await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  return getTransfer(transferId);
}

/** Delete all admin-uploaded deliverable bytes for a transfer (hard delete). */
async function removeExtraFiles(transferId) {
  const rows = await db('transfer_extra_files').where({ transfer_id: transferId }).select('stored_path');
  const storage = getStorage();
  for (const r of rows) {
    if (!r.stored_path) continue;
    try {
      await storage.delete(r.stored_path);
    } catch (err) {
      logger.warn('transferService: failed to delete extra file', {
        transferId, path: r.stored_path, error: err.message,
      });
    }
  }
  try {
    if (storage.kind() === 'local') {
      const dir = storage.resolveLocalPath(extraFilesDirKey(transferId));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) { /* noop */ }
}

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------

/**
 * Email the download link to one or more recipients and record them. Sending is
 * best-effort per address (a bad SMTP config must not fail the whole create);
 * `sendTemplateEmail` is required lazily to avoid a service-load cycle.
 */
async function sendTransferEmails(transferId, emails) {
  const clean = [...new Set((emails || [])
    .map((e) => String(e || '').trim())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
  if (!clean.length) return { sent: 0, recipients: [] };

  const transfer = await db('transfers').where({ id: transferId }).first();
  if (!transfer) return { sent: 0, recipients: [] };

  const fileCountRow = await db('transfer_files').where('transfer_id', transferId).count('* as c').first();
  const extraCountRow = await db('transfer_extra_files').where('transfer_id', transferId).count('* as c').first();
  const fileCount = (Number(fileCountRow?.c) || 0) + (Number(extraCountRow?.c) || 0);

  const { sendTemplateEmail } = require('./emailProcessor');
  const downloadUrl = `${await getFrontendUrl()}/transfer/${transfer.token}`;
  const vars = {
    transfer_title: transfer.title || `Transfer #${transferId}`,
    message: transfer.message || '',
    download_url: downloadUrl,
    file_count: String(fileCount),
    expiry_date: transfer.expires_at ? new Date(transfer.expires_at).toISOString().slice(0, 10) : '',
  };

  let sent = 0;
  for (const email of clean) {
    try {
      await sendTemplateEmail(email, 'transfer_ready', vars);
      sent += 1;
    } catch (err) {
      logger.warn('transferService: failed to send transfer_ready email', {
        transferId, email, error: err.message,
      });
    }
    // Record the recipient regardless of delivery so the detail panel shows who
    // it was addressed to (and a future resend has the list).
    const existing = await db('transfer_recipients').where({ transfer_id: transferId, email }).first();
    if (existing) {
      await db('transfer_recipients').where({ id: existing.id }).update({ last_sent_at: new Date() });
    } else {
      await db('transfer_recipients').insert({
        transfer_id: transferId, email, created_at: new Date(), last_sent_at: new Date(),
      });
    }
  }
  return { sent, recipients: clean };
}

// ---------------------------------------------------------------------------
// Client uploads
// ---------------------------------------------------------------------------

function assertUploadable(transfer) {
  if (!transfer || transfer.deleted_at) return { ok: false, code: 'NOT_FOUND', status: 404 };
  const allow = transfer.allow_uploads === true || transfer.allow_uploads === 1;
  if (!allow) return { ok: false, code: 'UPLOADS_DISABLED', status: 403 };
  const exp = transfer.upload_expires_at || transfer.expires_at;
  if (exp && new Date(exp).getTime() <= Date.now()) {
    return { ok: false, code: 'UPLOAD_EXPIRED', status: 410 };
  }
  return { ok: true };
}

/** Record a client-uploaded file (bytes already written by the route/multer). */
async function addUpload(transferId, { originalFilename, storedPath, sizeBytes, mimeType, ip }) {
  const [id] = await db('transfer_uploads').insert({
    transfer_id: transferId,
    original_filename: String(originalFilename || 'file').slice(0, 512),
    stored_path: storedPath,
    size_bytes: sizeBytes || null,
    mime_type: mimeType || null,
    uploader_ip: ip || null,
    uploaded_at: new Date(),
  }).returning('id');
  await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  return typeof id === 'object' && id !== null ? id.id : id;
}

/** Resolve the on-disk path of a stored upload for admin download / deletion. */
async function getUpload(transferId, uploadId) {
  const upload = await db('transfer_uploads')
    .where({ id: uploadId, transfer_id: transferId })
    .first();
  if (!upload) return null;
  const storage = getStorage();
  let localPath = null;
  try {
    localPath = storage.kind() === 'local' ? storage.resolveLocalPath(upload.stored_path) : null;
  } catch (_) {
    localPath = null;
  }
  return { ...upload, localPath };
}

/** Delete all client-uploaded bytes for a transfer (retention / hard delete). */
async function removeUploadedFiles(transferId) {
  const uploads = await db('transfer_uploads').where({ transfer_id: transferId }).select('stored_path');
  const storage = getStorage();
  for (const u of uploads) {
    if (!u.stored_path) continue;
    try {
      await storage.delete(u.stored_path);
    } catch (err) {
      logger.warn('transferService: failed to delete upload file', {
        transferId, path: u.stored_path, error: err.message,
      });
    }
  }
  // Best-effort: remove the now-empty per-transfer directory on local storage.
  try {
    if (storage.kind() === 'local') {
      const dir = storage.resolveLocalPath(uploadDirKey(transferId));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) { /* noop */ }
}

module.exports = {
  // constants / helpers
  UPLOAD_TOKEN_LENGTH,
  getFrontendUrl,
  uploadDirKey,
  extraFilesDirKey,
  computeStatus,
  downloadsRemaining,
  // admin CRUD
  createTransfer,
  listTransfers,
  getTransfer,
  getTransferOwner,
  filterOwnedPhotoIds,
  updateTransfer,
  deleteTransfer,
  addFiles,
  removeFile,
  addExtraFile,
  removeExtraFile,
  removeExtraFiles,
  enableUploads,
  disableUploads,
  sendTransferEmails,
  // public
  getTransferByToken,
  getTransferByUploadToken,
  generateUniqueUploadToken,
  getPublicView,
  assertDownloadable,
  claimDownload,
  streamTransferArchive,
  streamTransferFile,
  streamTransferExtraFile,
  // uploads
  assertUploadable,
  addUpload,
  getUpload,
  removeUploadedFiles,
};
