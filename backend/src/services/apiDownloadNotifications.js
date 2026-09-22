/**
 * Keeps v1 original downloads (issue 1473) from flooding the admin
 * notification bell.
 *
 * Every single download writes its own `api_photo_downloaded` activity row —
 * the audit, ids only. An n8n flow fetching an event photo by photo would put
 * one bell entry per photo on top of that, so the bell leaves those rows out
 * (BELL_EXCLUDED_ACTIVITY_TYPES) and reads one `api_photos_downloaded` summary
 * row per token, event and hour instead, whose count grows with each download.
 * The gallery applies the same one-per-event-per-hour rule to guest single
 * downloads (notifySinglePhotoDownload in routes/gallery/downloads.js).
 *
 * The window lives in the summary row, not in process memory, so it survives
 * a restart and is shared by replicas. Updates for one token/event pair are
 * chained in-process so parallel downloads don't lose increments; two
 * replicas opening the same window at the same instant can still produce two
 * rows, which only costs a second bell entry.
 */

const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');

const SUMMARY_TYPE = 'api_photos_downloaded';
const AUDIT_TYPE = 'api_photo_downloaded';
const BELL_EXCLUDED_ACTIVITY_TYPES = [AUDIT_TYPE];
const SUMMARY_WINDOW_MS = 60 * 60 * 1000;

const chains = new Map();

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function bumpSummary({ tokenId, tokenName, eventId, actor }) {
  const now = Date.now();
  const recent = await db('activity_logs')
    .where({ activity_type: SUMMARY_TYPE, event_id: eventId })
    .orderBy('id', 'desc')
    .limit(20)
    .select('id', 'metadata');
  const open = recent
    .map((row) => ({ id: row.id, metadata: parseMetadata(row.metadata) }))
    .find(({ metadata }) => Number(metadata.token_id) === Number(tokenId)
      && now - Number(metadata.window_started_at) < SUMMARY_WINDOW_MS);

  if (open) {
    await db('activity_logs').where({ id: open.id }).update({
      metadata: JSON.stringify({ ...open.metadata, count: (Number(open.metadata.count) || 0) + 1 }),
      // Back to unread, so the bell shows the grown count.
      read_at: null
    });
    return;
  }

  await logActivity(SUMMARY_TYPE, {
    via: 'api_v1',
    token_id: tokenId,
    token_name: tokenName,
    count: 1,
    window_started_at: now
  }, eventId, actor);
}

/** Count one single download into its token/event/hour bell entry. */
function recordSingleDownload({ tokenId, tokenName, eventId, actor }) {
  const key = `${tokenId}:${eventId}`;
  const next = (chains.get(key) || Promise.resolve())
    .then(() => bumpSummary({ tokenId, tokenName, eventId, actor }))
    .catch((err) => logger.warn('API download notification could not be recorded', { error: err.message }));
  chains.set(key, next);
  next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

module.exports = {
  recordSingleDownload,
  BELL_EXCLUDED_ACTIVITY_TYPES,
  SUMMARY_TYPE,
  SUMMARY_WINDOW_MS
};
