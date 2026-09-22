/**
 * customerDocumentAbuse — abuse signals on the portal's document routes
 * (#1444, plan slice 9; migration 241).
 *
 *   forbidden_access  a document id that EXISTS but belongs to another
 *                     customer. Never recorded for an id that doesn't exist:
 *                     then the log itself would be the existence oracle the
 *                     identical 404 avoids.
 *   quota_exceeded    the 413 on an upload.
 *   rate_limited      the upload/delete rate limit tripped.
 *
 * Counted per customer, signal and hour in customer_document_abuse_counters.
 * The first hit of a window writes one activity row
 * (customer_document_<signal>) with ids only; later hits only count. When
 * forbidden-access for one customer reaches the threshold setting within the
 * window, the business address gets one mail. Both "once"s are claimed with a
 * conditional update, so several replicas still log and alert once.
 *
 * Recording never fails the request it describes: errors are logged and
 * swallowed.
 */

const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');

const HOUR_MS = 60 * 60 * 1000;
const SIGNALS = new Set(['forbidden_access', 'quota_exceeded', 'rate_limited']);

const windowOf = (now) => Math.floor(now / HOUR_MS) * HOUR_MS;

async function thresholdFor() {
  const n = Number(await getAppSetting('customer_documents_forbidden_alert_threshold', 20));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}

async function alertBusiness(customerId, count) {
  const profile = await db('business_profile').where({ id: 1 }).first('email');
  if (!profile || !profile.email) return;
  const customer = await db('customer_accounts').where({ id: customerId })
    .first('email', 'display_name', 'first_name', 'last_name');
  const name = (customer && ((customer.display_name && customer.display_name.trim())
    || [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || String(customer.email || '').split('@')[0])) || `#${customerId}`;
  const base = ((await getFrontendBaseUrl()) || 'http://localhost:3000').replace(/\/+$/, '');
  await require('./emailProcessor').queueEmail(null, profile.email, 'customer_document_access_alert_admin', {
    customer_name: name,
    attempt_count: String(count),
    admin_link: `${base}/admin/clients/accounts/${customerId}`,
  });
}

/**
 * @param {number} customerId
 * @param {'forbidden_access'|'quota_exceeded'|'rate_limited'} signal
 */
async function record(customerId, signal, now = Date.now()) {
  if (!SIGNALS.has(signal) || !customerId) return;
  try {
    const windowStart = windowOf(now);
    const key = { customer_account_id: customerId, signal, window_start: windowStart };
    await db('customer_document_abuse_counters')
      .insert({ ...key, count: 1 })
      .onConflict(['customer_account_id', 'signal', 'window_start'])
      .merge({ count: db.raw('?? + 1', ['customer_document_abuse_counters.count']) });

    const stamp = new Date(now).toISOString();
    const firstOfWindow = await db('customer_document_abuse_counters')
      .where(key).whereNull('logged_at')
      .update({ logged_at: stamp });
    if (firstOfWindow > 0) {
      await logActivity(`customer_document_${signal}`, { customerId }, null,
        { type: 'customer', id: customerId, name: null });
    }

    if (signal === 'forbidden_access') {
      const threshold = await thresholdFor();
      const claimed = await db('customer_document_abuse_counters')
        .where(key).whereNull('alerted_at').where('count', '>=', threshold)
        .update({ alerted_at: stamp });
      if (claimed > 0) {
        const row = await db('customer_document_abuse_counters').where(key).first('count');
        await logActivity('customer_document_forbidden_access_alert',
          { customerId, count: Number(row && row.count) || threshold }, null, { type: 'system', name: null });
        await alertBusiness(customerId, Number(row && row.count) || threshold);
      }
    }
  } catch (err) {
    logger.warn('Could not record a document abuse signal', { customerId, signal, error: err.message });
  }
}

/**
 * Record forbidden_access when `documentId` exists and belongs to a customer
 * other than `customerId`. Called on the portal's 404 path only.
 */
async function recordIfForeign(customerId, documentId) {
  try {
    if (!Number.isInteger(documentId) || documentId < 1) return;
    const foreign = await db('customer_documents')
      .where({ id: documentId })
      .whereNot('customer_account_id', customerId)
      .first('id');
    if (foreign) await record(customerId, 'forbidden_access');
  } catch (err) {
    logger.warn('Could not check a document id for abuse', { customerId, error: err.message });
  }
}

// Recordings started after a response went out. Tracked so tests (and a
// draining shutdown) can wait for them; never awaited on the request path.
const inFlight = new Set();

/**
 * recordIfForeign without awaiting it: for the 404 path, where the extra
 * queries a foreign id costs must not add to the response time.
 */
function recordIfForeignLater(customerId, documentId) {
  const p = Promise.resolve(module.exports.recordIfForeign(customerId, documentId))
    .catch((err) => logger.warn('Could not record a document abuse signal', { customerId, error: err.message }))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** Resolves once every recording started so far has finished. */
async function settled() {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/** 24-hour totals per signal, for System Health. */
async function last24hCounts(now = Date.now()) {
  const out = { forbiddenAccess: 0, quotaExceeded: 0, rateLimited: 0, customersOverThreshold: 0 };
  if (!(await db.schema.hasTable('customer_document_abuse_counters'))) return out;
  const since = windowOf(now) - 23 * HOUR_MS;
  const rows = await db('customer_document_abuse_counters')
    .where('window_start', '>=', since)
    .groupBy('signal')
    .select('signal')
    .sum({ total: 'count' });
  for (const r of rows) {
    const total = Number(r.total) || 0;
    if (r.signal === 'forbidden_access') out.forbiddenAccess = total;
    if (r.signal === 'quota_exceeded') out.quotaExceeded = total;
    if (r.signal === 'rate_limited') out.rateLimited = total;
  }
  const alerted = await db('customer_document_abuse_counters')
    .where('window_start', '>=', since).whereNotNull('alerted_at')
    .countDistinct({ c: 'customer_account_id' }).first();
  out.customersOverThreshold = Number(alerted && alerted.c) || 0;
  return out;
}

module.exports = {
  record, recordIfForeign, recordIfForeignLater, settled, last24hCounts, _internal: { windowOf },
};
