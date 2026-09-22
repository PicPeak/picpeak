/**
 * customerActivityService — one customer's timeline for the admin customer
 * record (#1444, plan slice 6).
 *
 * Reads activity_logs, filtered on the structured metadata (every type below
 * carries `customerId`) rather than a LIKE over the JSON text: `->>` on
 * PostgreSQL, json_extract on SQLite, compared as text on both so a number
 * and a numeric string match alike.
 *
 * Paginates by row id (`beforeId`), not by time. created_at comes back as a
 * Date on PostgreSQL and as SQLite's zone-less CURRENT_TIMESTAMP text, which
 * no SQL comparison against an ISO string orders correctly; ids are
 * monotonic on both.
 *
 * Returns ids and small fields only. Metadata keys that could carry personal
 * data (email, IP address) are not passed through.
 */

const { db } = require('../database/db');
const { isPostgreSQL } = require('../utils/dbCompat');
const { toMillis } = require('../utils/queueTimestamps');

const CUSTOMER_TYPES = [
  'customer_created_passive',
  'customer_invitation_accepted',
  'customer_login',
  'customer_updated',
  'customer_deactivated',
  'customer_reactivated',
  'customer_password_reset_requested',
  'customer_password_reset_applied',
  'customer_password_change',
  'customer_self_profile_update',
  'customer_groups_assigned',
  'customer_marketing_opt_out',
];

// Metadata fields a timeline row may show. Everything else stays in the log.
const SAFE_META = ['documentId', 'status', 'eventId', 'requestId', 'count', 'step', 'uploaderType'];

function whereCustomerId(q, customerId) {
  if (isPostgreSQL()) {
    q.whereRaw('(activity_logs.metadata ->> \'customerId\') = ?', [String(customerId)]);
  } else {
    q.whereRaw(
      'CAST(CASE WHEN json_valid(activity_logs.metadata) THEN json_extract(activity_logs.metadata, \'$.customerId\') END AS TEXT) = ?',
      [String(customerId)],
    );
  }
}

const parseMeta = (v) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
};

/**
 * @param {number} customerId
 * @param {{ limit?: number, beforeId?: number|null }} options
 * @returns {Promise<{ entries: object[], nextBeforeId: number|null }>}
 */
async function listForCustomer(customerId, { limit = 50, beforeId = null } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const q = db('activity_logs')
    .andWhere((w) => {
      w.where('activity_type', 'like', 'customer_document_%')
        .orWhereIn('activity_type', CUSTOMER_TYPES);
    })
    .orderBy('id', 'desc')
    .limit(size + 1)
    .select('id', 'activity_type', 'actor_type', 'actor_name', 'metadata', 'event_id', 'created_at');
  whereCustomerId(q, customerId);
  if (beforeId) q.where('id', '<', beforeId);
  const rows = await q;

  const page = rows.slice(0, size);
  const entries = page.map((r) => {
    const meta = parseMeta(r.metadata);
    const safe = {};
    for (const k of SAFE_META) if (meta[k] !== undefined) safe[k] = meta[k];
    // SQLite's CURRENT_TIMESTAMP is zone-less UTC text; toMillis reads it
    // as UTC, where a plain Date parse would take it as local time.
    const ms = toMillis(r.created_at);
    return {
      id: r.id,
      type: r.activity_type,
      at: ms === null ? null : new Date(ms).toISOString(),
      // A customer's own name in their own timeline is fine; for admins it
      // is the username the log already carries.
      actorType: r.actor_type,
      actorName: r.actor_type === 'admin' ? (r.actor_name || null) : null,
      eventId: r.event_id || null,
      metadata: safe,
    };
  });
  return { entries, nextBeforeId: rows.length > size ? page[page.length - 1].id : null };
}

module.exports = { listForCustomer, CUSTOMER_TYPES };
