const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');

const SECRET_PREFIX = 'whsec_';

/**
 * Event types PicPeak emits. Keep this in sync with the README catalog and
 * the receiver-side type unions in any SDK we publish later. Consumers of
 * `fire(eventType, ...)` MUST use one of these strings — the worker will
 * silently drop unknown types so a typo can't 500 a request handler.
 */
const EVENT_TYPES = Object.freeze([
  'event.created',
  'event.published',
  'event.archived',
  'event.expired',
  'photo.uploaded',
  'photo.deleted',
]);

function generateSecret() {
  const random = crypto.randomBytes(24).toString('base64url'); // ~32 chars
  const plaintext = `${SECRET_PREFIX}${random}`;
  return {
    plaintext,
    preview: random.slice(0, 8),
  };
}

/**
 * Sign a payload with the webhook's secret. Used by the delivery worker;
 * exported for unit tests of receiver-side verification snippets.
 */
function signPayload(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Resolve a dot-path on an object (e.g. "data.event.event_type") with no
 * eval. Returns undefined for missing segments — never throws.
 */
function getByPath(obj, dotPath) {
  if (!dotPath || typeof dotPath !== 'string') return undefined;
  return dotPath.split('.').reduce((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return acc[key];
  }, obj);
}

/**
 * Evaluate a webhook's filter against an outgoing payload. The filter is a
 * flat object of dot-path → expected value pairs:
 *   { "data.event.event_type": "wedding" }
 *   { "type": "event.published", "data.event.id": 42 }
 *
 * All keys must match (logical AND). Equality is `===` after JSON-style
 * coercion: numbers as numbers, booleans as booleans. Empty filter
 * matches everything (back-compat).
 */
function payloadMatchesFilter(filter, payload) {
  if (!filter || typeof filter !== 'object') return true;
  const keys = Object.keys(filter);
  if (keys.length === 0) return true;
  for (const key of keys) {
    const expected = filter[key];
    const actual = getByPath(payload, key);
    if (Array.isArray(expected)) {
      // Array means "any of"
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Render a webhook template by substituting ${dot.path} expressions with
 * values from the payload. NO eval, NO logic — pure string substitution.
 * Caps output at 64KB; bails out and returns null if exceeded so the
 * delivery worker can fall back to the default envelope.
 */
function renderTemplate(template, payload) {
  if (template == null || template === '') return null;
  if (typeof template !== 'string') return null;
  const MAX_OUTPUT = 64 * 1024;
  const MAX_SUBSTITUTIONS = 64;
  let count = 0;
  const rendered = template.replace(/\$\{([^}]+)\}/g, (_match, expr) => {
    count += 1;
    if (count > MAX_SUBSTITUTIONS) return '';
    const value = getByPath(payload, expr.trim());
    if (value == null) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return ''; }
    }
    return String(value);
  });
  if (Buffer.byteLength(rendered, 'utf8') > MAX_OUTPUT) return null;
  return rendered;
}

/**
 * Validate a template at create-time so admins get immediate feedback
 * instead of silent delivery failures. Returns { valid, error? }.
 */
function validateTemplate(template) {
  if (template == null || template === '') return { valid: true };
  if (typeof template !== 'string') return { valid: false, error: 'template must be a string' };
  if (Buffer.byteLength(template, 'utf8') > 8192) return { valid: false, error: 'template exceeds 8KB' };
  // Reject unbalanced ${ that would silently swallow content at render.
  const opens = (template.match(/\$\{/g) || []).length;
  const closes = (template.match(/\}/g) || []).length;
  // Count is approximate (every } is counted, even non-matching ones).
  // We require at least as many } as ${, which is necessary but not sufficient.
  if (opens > closes) return { valid: false, error: 'template has unbalanced ${ — every ${ needs a matching }' };
  if (opens > 64) return { valid: false, error: 'template exceeds 64 substitutions' };
  return { valid: true };
}

/**
 * Constant-time signature comparison helper for receivers and tests.
 * Exposed so the same primitive backs verification examples in the README.
 */
function verifySignature(secret, rawBody, signature) {
  const expected = signPayload(secret, rawBody);
  const a = Buffer.from(expected, 'hex');
  let b;
  try {
    b = Buffer.from(signature || '', 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Enqueue a webhook delivery for every active webhook subscribed to
 * `eventType`. NEVER throws — webhook failures must not break the
 * lifecycle handler that emitted the event. Worker handles HTTP delivery.
 *
 * @param {string} eventType — one of EVENT_TYPES
 * @param {object} data — opaque payload that gets nested under .data in
 *                        the outbound JSON body
 */
async function fire(eventType, data) {
  if (!EVENT_TYPES.includes(eventType)) {
    logger.warn(`[webhookService] dropping unknown event type: ${eventType}`);
    return;
  }

  try {
    // jsonb @> ARRAY check across vendors: both pg and sqlite drivers we
    // support handle a simple WHERE on `active=true` then a runtime filter
    // on the events array; doing the array filter here keeps the query
    // portable.
    const candidates = await db('webhooks').where({ active: true });
    const subscribed = candidates.filter((w) => {
      const evts = Array.isArray(w.events)
        ? w.events
        : (() => { try { return JSON.parse(w.events) || []; } catch { return []; } })();
      return evts.includes(eventType);
    });

    if (subscribed.length === 0) return;

    const now = new Date();
    const buildEnvelope = (deliveryUuid) => ({
      id: deliveryUuid,
      type: eventType,
      created_at: now.toISOString(),
      data,
    });

    const rows = [];
    for (const w of subscribed) {
      const deliveryUuid = crypto.randomUUID();
      const envelope = buildEnvelope(deliveryUuid);

      // Filter (#327 follow-up): per-webhook predicate evaluated against
      // the payload. Skip insertion when it doesn't match.
      const filter = parseJsonField(w.filter, {});
      if (!payloadMatchesFilter(filter, envelope)) continue;

      rows.push({
        webhook_id: w.id,
        event_type: eventType,
        payload: JSON.stringify(envelope),
        attempt_count: 0,
        status: 'pending',
        next_retry_at: now,
        created_at: now,
      });
    }

    if (rows.length === 0) return;
    await db('webhook_deliveries').insert(rows);
  } catch (err) {
    // Log but don't throw — caller's transaction has already committed
    // by the time we get here, and we don't want to mask the success.
    logger.error(`[webhookService.fire] failed to enqueue ${eventType}: ${err.message}`);
  }
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

/**
 * Enqueue a delivery for ONE specific active webhook subscription, bypassing the
 * event-type subscription matching that `fire` does. Used by the workflow engine
 * `webhook` action: the flow author picks a configured webhook (which carries
 * the URL + signing secret + create-time URL validation), and the delivery then
 * rides the SAME worker pipeline as every other webhook — per-delivery SSRF
 * re-validation, HMAC signing, retries/backoff and the audit log, all for free.
 * Never throws. Returns { enqueued, reason?, deliveryId? }.
 */
async function enqueueForWebhook(webhookId, eventType, data) {
  try {
    const w = await db('webhooks').where({ id: webhookId, active: true }).first();
    if (!w) return { enqueued: false, reason: 'webhook not found or inactive' };
    const now = new Date();
    const deliveryUuid = crypto.randomUUID();
    const envelope = { id: deliveryUuid, type: eventType, created_at: now.toISOString(), data };
    await db('webhook_deliveries').insert({
      webhook_id: w.id,
      event_type: String(eventType).slice(0, 64),
      payload: JSON.stringify(envelope),
      attempt_count: 0,
      status: 'pending',
      next_retry_at: now,
      created_at: now,
    });
    return { enqueued: true, webhookId: w.id, deliveryId: deliveryUuid };
  } catch (err) {
    logger.error(`[webhookService.enqueueForWebhook] failed for #${webhookId}: ${err.message}`);
    return { enqueued: false, reason: err.message };
  }
}

/**
 * Canonical event sub-object for outbound webhooks (#341). Always returns
 * the full key set so receivers don't have to handle "field missing vs
 * field null" — pass whatever the caller has in scope, missing fields
 * become null. Adding a new field here propagates to every event.* type
 * payload at once.
 */
function buildEventSubject(input = {}) {
  const e = input || {};
  return {
    id: e.id ?? null,
    slug: e.slug ?? null,
    event_name: e.event_name ?? null,
    event_type: e.event_type ?? null,
    event_date: e.event_date ?? null,
    share_url: e.share_url ?? null,
    share_token: e.share_token ?? null,
    customer_name: e.customer_name ?? null,
    customer_email: e.customer_email ?? null,
    customer_phone: e.customer_phone ?? null,
  };
}

module.exports = {
  fire,
  enqueueForWebhook,
  generateSecret,
  signPayload,
  verifySignature,
  payloadMatchesFilter,
  renderTemplate,
  validateTemplate,
  getByPath,
  buildEventSubject,
  EVENT_TYPES,
  SECRET_PREFIX,
};
