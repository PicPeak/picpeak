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
 * chained in-process and written as a compare-and-set, so neither parallel
 * downloads nor replicas lose increments; two replicas opening the same
 * window at the same instant can still produce two rows, which only costs a
 * second bell entry.
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

// Summary rows read per page while looking for the caller's open window.
const LOOKUP_PAGE = 50;

/**
 * The token's still-open summary row for this event, or null. Rows are read
 * newest first; each row's window starts when it is created, so the first
 * closed window ends the search — every older row is closed too. Other
 * tokens' open rows are skipped however many there are.
 *
 * The metadata column is json on some installs and text on others; both cast
 * to the exact text that was stored, which the update below compares on.
 */
async function findOpenSummary(tokenId, eventId, now) {
  let beforeId = null;
  for (;;) {
    const query = db('activity_logs')
      .where({ activity_type: SUMMARY_TYPE, event_id: eventId })
      .orderBy('id', 'desc')
      .limit(LOOKUP_PAGE)
      .select('id', db.raw('CAST(metadata AS TEXT) AS metadata_text'));
    if (beforeId !== null) query.where('id', '<', beforeId);
    const rows = await query;
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata_text);
      if (!(now - Number(metadata.window_started_at) < SUMMARY_WINDOW_MS)) return null;
      if (Number(metadata.token_id) === Number(tokenId)) {
        return { id: row.id, text: row.metadata_text, metadata };
      }
    }
    if (rows.length < LOOKUP_PAGE) return null;
    beforeId = rows[rows.length - 1].id;
  }
}

// Attempts at the compare-and-set below before giving up on one increment.
const MAX_BUMP_ATTEMPTS = 5;

async function bumpSummary({ tokenId, tokenName, eventId, actor }) {
  for (let attempt = 0; attempt < MAX_BUMP_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const open = await findOpenSummary(tokenId, eventId, now);
    if (!open) {
      await logActivity(SUMMARY_TYPE, {
        via: 'api_v1',
        token_id: tokenId,
        token_name: tokenName,
        count: 1,
        window_started_at: now
      }, eventId, actor);
      return;
    }

    // Compare-and-set: the in-process chain serialises one replica, this
    // keeps a second replica's increment of the same row from being lost.
    const updated = await db('activity_logs')
      .where({ id: open.id })
      .whereRaw('CAST(metadata AS TEXT) = ?', [open.text])
      .update({
        metadata: JSON.stringify({ ...open.metadata, count: (Number(open.metadata.count) || 0) + 1 }),
        // Back to unread, so the bell shows the grown count.
        read_at: null
      });
    if (updated) return;
  }
  logger.warn('API download notification lost an increment under contention', { eventId });
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
