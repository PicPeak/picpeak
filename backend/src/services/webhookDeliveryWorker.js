const axios = require('axios');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { signPayload, renderTemplate } = require('./webhookService');
const { validateExternalUrl } = require('../utils/networkValidation');

const POLL_INTERVAL_MS = parseInt(process.env.WEBHOOK_DELIVERY_INTERVAL_MS || '5000', 10);
const CONCURRENCY = parseInt(process.env.WEBHOOK_DELIVERY_CONCURRENCY || '5', 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.WEBHOOK_HTTP_TIMEOUT_MS || '10000', 10);
const MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '5', 10);
const RESPONSE_TRUNCATE_BYTES = 1024;
// Mutable so tests can flip it without juggling require.cache; reads the
// env var at module load for the production code path.
let allowPrivateUrls = process.env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true';
const SIGNATURE_HEADER = 'X-PicPeak-Signature';
const EVENT_HEADER = 'X-PicPeak-Event';
const DELIVERY_HEADER = 'X-PicPeak-Delivery';

// Backoff schedule per the issue spec — index = attempt that just failed.
// attempt_count after the failure becomes (failedAttempt + 1); we look up
// the delay using the *new* attempt count to schedule the next try.
//   attempt 1 fails → wait 1m
//   attempt 2 fails → wait 5m
//   attempt 3 fails → wait 30m
//   attempt 4 fails → wait 2h
//   attempt 5 fails → wait 12h THEN give up (max 5 attempts total)
const BACKOFF_MS = [
  60_000,            // 1 min
  5 * 60_000,        // 5 min
  30 * 60_000,       // 30 min
  2 * 60 * 60_000,   // 2 h
  12 * 60 * 60_000,  // 12 h (only used when MAX_ATTEMPTS extended past 5)
];

let intervalHandle = null;
let stopped = false;
// Tracks deliveries currently being processed in this tick — guards
// against the same row being claimed twice if a tick takes longer than
// POLL_INTERVAL_MS.
const inFlight = new Set();

function truncate(str, bytes) {
  if (str == null) return null;
  const buf = Buffer.from(String(str), 'utf8');
  if (buf.length <= bytes) return buf.toString('utf8');
  return buf.subarray(0, bytes).toString('utf8');
}

async function fetchPending(limit) {
  // Skip rows already in-flight from a previous tick that's still running.
  const excludeIds = Array.from(inFlight);
  let q = db('webhook_deliveries')
    .where('status', 'pending')
    .where('next_retry_at', '<=', new Date())
    .orderBy('next_retry_at', 'asc')
    .limit(limit);
  if (excludeIds.length > 0) {
    q = q.whereNotIn('id', excludeIds);
  }
  return q.select('*');
}

async function deliverOne(row) {
  const startedAt = Date.now();
  const webhook = await db('webhooks').where({ id: row.webhook_id }).first();

  if (!webhook) {
    // Webhook was deleted while a delivery was pending. Mark failed and move on.
    await db('webhook_deliveries')
      .where({ id: row.id })
      .update({
        status: 'failed',
        last_error: 'webhook subscription no longer exists',
        completed_at: new Date(),
        attempt_count: row.attempt_count + 1,
      });
    return;
  }

  if (!webhook.active) {
    // Subscription disabled mid-flight. Don't abandon — leave as failed
    // so the deliveries page reflects the reality.
    await db('webhook_deliveries')
      .where({ id: row.id })
      .update({
        status: 'failed',
        last_error: 'webhook is disabled',
        completed_at: new Date(),
        attempt_count: row.attempt_count + 1,
      });
    return;
  }

  // Re-validate URL per delivery — DNS-rebinding mitigation. Admin can opt
  // out via WEBHOOK_ALLOW_PRIVATE_URLS=true for local-receiver dev runs.
  if (!allowPrivateUrls) {
    const urlCheck = validateExternalUrl(webhook.url);
    if (!urlCheck.valid) {
      await markFailedFinal(row, `URL rejected: ${urlCheck.error}`);
      return;
    }
  }

  const envelopeBody = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
  const envelopeObj = (() => {
    try { return JSON.parse(envelopeBody); } catch { return {}; }
  })();

  // Per-webhook template (#327 follow-up). If set + valid, replaces the
  // default JSON envelope as the request body. Signature is computed over
  // the BODY ACTUALLY SENT, so receivers verify whatever they receive.
  let rawBody = envelopeBody;
  let contentType = 'application/json';
  if (webhook.template) {
    const rendered = renderTemplate(webhook.template, envelopeObj);
    if (rendered != null) {
      rawBody = rendered;
      // Best-effort content-type detection: if it parses as JSON, keep
      // application/json; otherwise send as text/plain.
      try { JSON.parse(rendered); } catch { contentType = 'text/plain; charset=utf-8'; }
    }
  }
  const signature = signPayload(webhook.secret, rawBody);
  const deliveryId = envelopeObj?.id || String(row.id);

  let response;
  let networkError;
  try {
    response = await axios.post(webhook.url, rawBody, {
      headers: {
        'Content-Type': contentType,
        [SIGNATURE_HEADER]: signature,
        [EVENT_HEADER]: row.event_type,
        [DELIVERY_HEADER]: deliveryId,
        'User-Agent': 'PicPeak-Webhooks/1.0',
      },
      timeout: HTTP_TIMEOUT_MS,
      // Don't throw on non-2xx; we handle status manually.
      validateStatus: () => true,
      // Don't follow redirects — security + receivers should give us the
      // final URL up front.
      maxRedirects: 0,
      // Cap response body so a chatty receiver can't OOM us before truncation.
      maxContentLength: 10 * 1024,
      maxBodyLength: rawBody.length + 1024,
    });
  } catch (err) {
    networkError = err;
  }

  const latency = Date.now() - startedAt;
  const newAttempt = row.attempt_count + 1;

  if (response && response.status >= 200 && response.status < 300) {
    await db('webhook_deliveries')
      .where({ id: row.id })
      .update({
        status: 'success',
        response_status: response.status,
        response_body: truncate(stringifyBody(response.data), RESPONSE_TRUNCATE_BYTES),
        latency_ms: latency,
        attempt_count: newAttempt,
        completed_at: new Date(),
        next_retry_at: null,
      });
    await db('webhooks').where({ id: webhook.id }).update({ last_success_at: new Date() });
    return;
  }

  // Failure path — schedule retry or give up.
  const errorMsg = networkError
    ? `network error: ${networkError.code || networkError.message}`
    : `non-2xx status: ${response?.status}`;

  if (newAttempt >= MAX_ATTEMPTS) {
    await db('webhook_deliveries')
      .where({ id: row.id })
      .update({
        status: 'failed',
        response_status: response?.status || null,
        response_body: response ? truncate(stringifyBody(response.data), RESPONSE_TRUNCATE_BYTES) : null,
        last_error: errorMsg,
        latency_ms: latency,
        attempt_count: newAttempt,
        completed_at: new Date(),
        next_retry_at: null,
      });
    await db('webhooks').where({ id: webhook.id }).update({ last_failure_at: new Date() });
    return;
  }

  const backoff = BACKOFF_MS[Math.min(newAttempt - 1, BACKOFF_MS.length - 1)];
  await db('webhook_deliveries')
    .where({ id: row.id })
    .update({
      status: 'pending',
      response_status: response?.status || null,
      response_body: response ? truncate(stringifyBody(response.data), RESPONSE_TRUNCATE_BYTES) : null,
      last_error: errorMsg,
      latency_ms: latency,
      attempt_count: newAttempt,
      next_retry_at: new Date(Date.now() + backoff),
    });
  await db('webhooks').where({ id: webhook.id }).update({ last_failure_at: new Date() });
}

async function markFailedFinal(row, reason) {
  await db('webhook_deliveries')
    .where({ id: row.id })
    .update({
      status: 'failed',
      last_error: reason,
      attempt_count: row.attempt_count + 1,
      completed_at: new Date(),
      next_retry_at: null,
    });
  await db('webhooks').where({ id: row.webhook_id }).update({ last_failure_at: new Date() });
}

function stringifyBody(data) {
  if (data == null) return null;
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  try { return JSON.stringify(data); } catch { return String(data); }
}

async function tick() {
  if (stopped) return;
  try {
    const slots = Math.max(0, CONCURRENCY - inFlight.size);
    if (slots === 0) return;
    const rows = await fetchPending(slots);
    if (rows.length === 0) return;
    rows.forEach((r) => inFlight.add(r.id));
    await Promise.allSettled(
      rows.map((r) =>
        deliverOne(r)
          .catch((err) => logger.error(`[webhookWorker] delivery ${r.id} crashed: ${err.message}`))
          .finally(() => inFlight.delete(r.id))
      )
    );
  } catch (err) {
    logger.error(`[webhookWorker] tick failed: ${err.message}`);
  }
}

function startWebhookDeliveryWorker() {
  if (intervalHandle) return; // idempotent
  stopped = false;
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  logger.info(
    `[webhookWorker] started — interval=${POLL_INTERVAL_MS}ms, concurrency=${CONCURRENCY}, ` +
    `max_attempts=${MAX_ATTEMPTS}, allow_private=${allowPrivateUrls}`
  );
}

function stopWebhookDeliveryWorker() {
  stopped = true;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  startWebhookDeliveryWorker,
  stopWebhookDeliveryWorker,
  // exported for tests
  __test: {
    tick,
    BACKOFF_MS,
    SIGNATURE_HEADER,
    EVENT_HEADER,
    DELIVERY_HEADER,
    setAllowPrivateUrls(value) { allowPrivateUrls = !!value; },
  },
};
