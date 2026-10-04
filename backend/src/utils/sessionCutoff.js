/**
 * Global session cutoff.
 *
 * A .picpeak restore rewrites admin_users / customer_accounts / events and can
 * reassign their primary keys, so any JWT issued BEFORE the restore may now
 * resolve to a different restored principal (auth middleware binds a token to
 * `decoded.id`; IP is only logged and the backup controls each row's
 * `password_changed_at`). Revoking the single importing token is not enough —
 * every pre-restore admin, customer, and gallery session must stop being
 * honoured.
 *
 * We record a single unix-second cutoff in app_settings and reject any token
 * whose `iat` predates it, across all three JWT auth paths. The operator's
 * forced re-login mints a token with `iat >= cutoff`, so it passes; everything
 * issued earlier is refused. The value is cached briefly so the common auth
 * path stays a single in-memory comparison.
 */
const { db } = require('../database/db');
const logger = require('./logger');

const CUTOFF_KEY = 'security_sessions_valid_after';
const CACHE_MS = 30 * 1000; // restores are rare; a short TTL keeps auth cheap

let cache = null; // { value: number, expiry: number }

async function readCutoffFromDb() {
  const row = await db('app_settings')
    .where('setting_key', CUTOFF_KEY)
    .first()
    .timeout(5000);
  if (!row || row.setting_value == null) return 0;
  let value = row.setting_value;
  // pg `json` returns a parsed number; sqlite returns the stored string.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { /* fall through to parseInt */ }
  }
  const seconds = parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * Cutoff as unix seconds (0 = no cutoff set). Cached for CACHE_MS. On a
 * transient DB error, returns the last known value (or 0) rather than blocking
 * auth — the cutoff is defence-in-depth layered on top of per-token revocation.
 */
async function getSessionsValidAfter() {
  const now = Date.now();
  if (cache && now < cache.expiry) return cache.value;
  try {
    const value = await readCutoffFromDb();
    cache = { value, expiry: now + CACHE_MS };
    return value;
  } catch (err) {
    logger.warn('[sessionCutoff] failed to read cutoff:', err.message);
    return cache ? cache.value : 0;
  }
}

/** Persist a new cutoff (unix seconds) and refresh the in-process cache. */
async function setSessionsValidAfter(unixSeconds) {
  await db('app_settings')
    .insert({
      setting_key: CUTOFF_KEY,
      setting_value: JSON.stringify(unixSeconds),
      setting_type: 'number',
      updated_at: new Date(),
    })
    .onConflict('setting_key')
    .merge({ setting_value: JSON.stringify(unixSeconds), setting_type: 'number', updated_at: new Date() });
  cache = { value: unixSeconds, expiry: Date.now() + CACHE_MS };
}

/**
 * True when this token was issued before the global cutoff. Fail-open on any
 * error: the cutoff is defence-in-depth on top of per-token revocation and the
 * post-restore cookie clear, and must never turn a transient read failure into
 * an auth outage.
 */
async function isTokenBeforeCutoff(decoded) {
  try {
    if (!decoded || !decoded.iat) return false;
    const cutoff = await getSessionsValidAfter();
    if (!cutoff) return false;
    return decoded.iat < cutoff;
  } catch (err) {
    logger.warn('[sessionCutoff] check failed, allowing token:', err.message);
    return false;
  }
}

/** Test-only: drop the in-process cache. */
/**
 * Session cutoff for identity tables that were just replaced (restore,
 * rollback, portable import). isTokenBeforeCutoff() rejects `iat < cutoff`
 * and a JWT's iat is a whole second, so a cutoff of "now" would let a token
 * minted earlier in the same second survive. The next second puts everything
 * issued up to and including this one out.
 */
function nextSessionCutoff() {
  return Math.floor(Date.now() / 1000) + 1;
}

/**
 * Resolve once the wall clock has reached the cutoff. Until then a fresh
 * login still gets `iat = cutoff - 1` and is rejected like a pre-restore
 * token, so the operation that stamped the cutoff must not report success
 * earlier: sessions created after a finished restore are valid. At most ~1 s.
 */
async function waitPastSessionCutoff(cutoff) {
  for (;;) {
    const remaining = cutoff * 1000 - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000)));
  }
}

/** Stamp the next-second cutoff and wait until it has passed. */
async function invalidateSessionsIssuedSoFar() {
  const cutoff = nextSessionCutoff();
  await setSessionsValidAfter(cutoff);
  await waitPastSessionCutoff(cutoff);
  return cutoff;
}

function _resetCache() { cache = null; }

module.exports = {
  CUTOFF_KEY,
  getSessionsValidAfter,
  setSessionsValidAfter,
  isTokenBeforeCutoff,
  nextSessionCutoff,
  waitPastSessionCutoff,
  invalidateSessionsIssuedSoFar,
  _resetCache,
};
