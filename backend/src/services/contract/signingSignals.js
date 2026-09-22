'use strict';

/**
 * Enumeration and replay signals on the public signing routes (#1446).
 *
 * The per-IP rate limits and per-signer caps stop a single burst; they say
 * nothing about someone patiently walking link tokens or codes. This counts
 * what that leaves behind, per hour:
 *
 *   unknown_token      a link or session token that matches nothing
 *   stale_token        a revoked, replaced or expired link, or an ended session
 *   otp_failure        a wrong code (per contract)
 *   rate_limited       a request the rate limiter refused
 *   idempotency_reuse  a signature key replayed with different details
 *   cross_contract     a session asking for a file that isn't its contract's
 *
 * Counts are kept in memory — at most MAX_KEYS keys; past that, a signal is
 * added to its kind's global count, which the global threshold still sees —
 * and flushed into `contract_signing_signals` (append-only; each replica
 * writes its own rows, reads sum them). A batch that fails to flush is kept
 * for the next flush, and dropped after MAX_FLUSH_FAILURES failures in a row.
 *
 * After a flush, the thresholds are checked over the hour so far: unknown
 * tokens per client (`crm_contracts_alert_unknown_tokens_per_ip`, default
 * 20 — only while client addresses may be kept), unknown tokens overall
 * (`crm_contracts_alert_unknown_tokens_per_hour`, default 200 — always, and
 * the only one with the "store IP" setting off) and wrong codes per contract
 * (`crm_contracts_alert_otp_failures_per_contract`, default 10). Crossing
 * one writes a `contract_signing_suspicious` activity entry and mails the
 * admin, once per rule per hour: the unique row in `contract_signing_alerts`
 * is the claim.
 *
 * The client is an HMAC of its rate-limit key (the IPv6 /64, or the IPv4
 * address) under a key derived from JWT_SECRET with HKDF, and nothing at all
 * when the "store IP" setting is off. No token, code or raw address is kept
 * or logged.
 */

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { isUniqueViolation } = require('../../utils/dbErrors');
const { scheduledTask } = require('../scheduledTask');

const KINDS = ['unknown_token', 'stale_token', 'otp_failure', 'rate_limited', 'idempotency_reuse', 'cross_contract'];
// `alert` is the rule's name in contract_signing_alerts (one per hour).
const THRESHOLDS = [
  { alert: 'unknown_token', kind: 'unknown_token', setting: 'crm_contracts_alert_unknown_tokens_per_ip', fallback: 20, per: 'ip_hash', needsClients: true },
  { alert: 'unknown_token:global', kind: 'unknown_token', setting: 'crm_contracts_alert_unknown_tokens_per_hour', fallback: 200, per: null },
  { alert: 'otp_failure', kind: 'otp_failure', setting: 'crm_contracts_alert_otp_failures_per_contract', fallback: 10, per: 'contract_id' },
];
const MAX_KEYS = 10000;
const MAX_FLUSH_FAILURES = 3;
const RETAIN_DAYS = 30;

// Error codes the signing routes answer with, and the signal each one is.
const CODE_TO_KIND = {
  SIGNING_LINK_INVALID: 'unknown_token',
  SIGNING_LINK_REVOKED: 'stale_token',
  SIGNING_LINK_EXPIRED: 'stale_token',
  CONTRACT_EXPIRED: 'stale_token',
  // An ended session; one that never existed carries signalKind 'unknown_token'.
  SIGNING_SESSION_INVALID: 'stale_token',
  OTP_WRONG: 'otp_failure',
  OTP_LOCKED: 'otp_failure',
  IDEMPOTENCY_KEY_REUSED: 'idempotency_reuse',
  ATTACHMENT_NOT_FOUND: 'cross_contract',
};

let pending = new Map();
let failedFlushes = 0;
// Counts still resolving the client (a settings read); a flush waits for them.
const inflight = new Set();

const hourOf = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 13);

let hmacKey = null;
let hmacSecret = null;
function ipHash(clientKey) {
  if (!clientKey) return null;
  const secret = process.env.JWT_SECRET || '';
  if (!hmacKey || hmacSecret !== secret) {
    hmacKey = Buffer.from(crypto.hkdfSync('sha256', secret, 'picpeak', 'picpeak-signing-signals', 32));
    hmacSecret = secret;
  }
  return crypto.createHmac('sha256', hmacKey).update(String(clientKey)).digest('hex');
}

/** Whether client addresses may be kept, i.e. per-client counting is on. */
async function clientsCounted() {
  const { maybeStoreIp } = require('./helpers');
  return !!(await maybeStoreIp('0.0.0.0'));
}

/** The client as the signals see it, or null when IPs are not to be kept. */
async function clientOf(clientKey) {
  const { maybeStoreIp } = require('./helpers');
  return (await maybeStoreIp(clientKey)) ? ipHash(clientKey) : null;
}

/** Count one signal. Never throws: a signal is never worth a failed request. */
function record(kind, { contractId = null, clientKey = null, at = Date.now() } = {}) {
  if (!KINDS.includes(kind)) return Promise.resolve();
  const counting = (async () => {
    try {
      const client = await clientOf(clientKey);
      let key = [hourOf(at), kind, contractId == null ? '' : Number(contractId), client || ''].join('|');
      // Bounded: past the cap a signal only counts for its kind as a whole.
      if (!pending.has(key) && pending.size >= MAX_KEYS) key = [hourOf(at), kind, '', ''].join('|');
      pending.set(key, (pending.get(key) || 0) + 1);
    } catch (err) {
      logger.warn('Could not count a signing signal', { kind, message: err.message });
    }
  })();
  inflight.add(counting);
  counting.finally(() => inflight.delete(counting));
  return counting;
}

/**
 * Express error observer for the signing router: counts the refusal the
 * error stands for, then hands it on unchanged. Services put the contract
 * id on the error (`signalContractId`) where it is known.
 */
function observe(err, req) {
  const kind = err && (err.signalKind || CODE_TO_KIND[err.code]);
  if (!kind) return;
  const { rateLimitKey } = require('../../utils/rateLimitKey');
  // The caller doesn't wait on it: the response must not wait for a count.
  return record(kind, { contractId: err.signalContractId ?? null, clientKey: rateLimitKey(req) });
}

/** Write the counts gathered so far. Returns the number of rows written. */
async function flush() {
  await Promise.all([...inflight]);
  if (!pending.size) return 0;
  const batch = pending;
  pending = new Map();
  const now = new Date().toISOString();
  const rows = [...batch.entries()].map(([key, count]) => {
    const [hour, kind, contractId, client] = key.split('|');
    return {
      hour, kind, contract_id: contractId === '' ? null : Number(contractId), ip_hash: client || null, count, created_at: now,
    };
  });
  try {
    await db.transaction(async (trx) => {
      for (let i = 0; i < rows.length; i += 200) await trx('contract_signing_signals').insert(rows.slice(i, i + 200));
    });
    failedFlushes = 0;
  } catch (err) {
    failedFlushes += 1;
    if (failedFlushes >= MAX_FLUSH_FAILURES) {
      // A store that keeps refusing must not make the counts grow for ever.
      logger.warn('Dropping signing signals that could not be stored', { rows: rows.length, message: err.message });
      failedFlushes = 0;
      throw err;
    }
    // Put them back for the next flush rather than lose them.
    for (const [key, count] of batch) pending.set(key, (pending.get(key) || 0) + count);
    throw err;
  }
  return rows.length;
}

/** Thresholds over the hour so far; returns the kinds that alerted now. */
async function checkThresholds(hour = hourOf()) {
  const alerted = [];
  const perClient = await clientsCounted();
  for (const rule of THRESHOLDS) {
    const { kind } = rule;
    if (rule.needsClients && !perClient) continue;
    const limit = Number(await getAppSetting(rule.setting, rule.fallback)) || rule.fallback;
    const query = db('contract_signing_signals').where({ hour, kind });
    const top = rule.per
      ? await query.whereNotNull(rule.per).groupBy(rule.per).select(rule.per).sum({ total: 'count' })
        .orderBy('total', 'desc').first()
      : await query.sum({ total: 'count' }).first();
    const total = top ? Number(top.total) || 0 : 0;
    if (total < limit) continue;
    try {
      await db('contract_signing_alerts').insert({ hour, kind: rule.alert, count: total, created_at: new Date().toISOString() });
    } catch (err) {
      if (isUniqueViolation(err)) continue; // another replica (or an earlier flush) already told the admin
      throw err;
    }
    alerted.push(rule.alert);
    const contractId = rule.per === 'contract_id' ? Number(top.contract_id) : null;
    try {
      await logActivity('contract_signing_suspicious', {
        kind, rule: rule.alert, hour, count: total, limit, ...(contractId ? { contractId } : {}),
      },
      null, { type: 'system', name: 'Signing alerts' });
    } catch (_) { /* logging is best-effort */ }
    const signingV2 = require('./signingV2');
    await signingV2.notifyAdmin('contract_signing_suspicious_admin_notification', {
      kind: rule.per ? kind : `${kind} (all sources together)`, hour: `${hour}:00 UTC`, count: String(total), limit: String(limit),
      contract_number: contractId
        ? ((await db('contracts').where({ id: contractId }).first('contract_number')) || {}).contract_number || ''
        : '',
    });
  }
  return alerted;
}

async function purgeOld(now = Date.now()) {
  const cutoff = hourOf(now - RETAIN_DAYS * 24 * 60 * 60 * 1000);
  await db('contract_signing_signals').where('hour', '<', cutoff).del();
  await db('contract_signing_alerts').where('hour', '<', cutoff).del();
}

async function runSignalFlush() {
  const { ensureContractEmailTemplatesSeeded } = require('../contractEmailTemplates');
  await ensureContractEmailTemplatesSeeded(db, logger);
  await flush();
  // A flush early in the hour writes the tail of the previous one (counts
  // gathered after its last flush, or a batch kept after a failed one);
  // the alert rows' unique claim keeps a second check from alerting twice.
  const now = Date.now();
  await checkThresholds(hourOf(now - 60 * 60 * 1000));
  await checkThresholds(hourOf(now));
  await purgeOld();
}

const task = scheduledTask(runSignalFlush, { interval: 10 * 60 * 1000 });

/** The last 24 hours per kind, and how many alerts went out (System Health). */
async function summary(now = Date.now()) {
  const since = hourOf(now - 24 * 60 * 60 * 1000);
  const rows = await db('contract_signing_signals').where('hour', '>=', since).groupBy('kind').select('kind').sum({ total: 'count' });
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (const row of rows) byKind[row.kind] = Number(row.total) || 0;
  const alerts = await db('contract_signing_alerts').where('hour', '>=', since).orderBy('hour', 'desc').select('hour', 'kind', 'count');
  return {
    since: `${since}:00:00.000Z`,
    // Which unknown-link threshold applies: per client while addresses may be
    // kept (plus the overall one), the overall one alone otherwise.
    mode: (await clientsCounted()) ? 'per_client' : 'global',
    byKind,
    alerts: alerts.map((a) => ({ hour: a.hour, kind: a.kind, count: Number(a.count) })),
  };
}

module.exports = {
  KINDS,
  record,
  observe,
  flush,
  checkThresholds,
  summary,
  runSignalFlush,
  startSigningSignals: () => task.start(),
  stopSigningSignals: () => task.stop(),
  MAX_KEYS,
  _internal: {
    ipHash, hourOf, pendingSize: () => pending.size, reset: () => { pending = new Map(); failedFlushes = 0; },
  },
};
