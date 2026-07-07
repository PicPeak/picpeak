// Worker reads WEBHOOK_ALLOW_PRIVATE_URLS at module-load. Set it BEFORE
// requiring the worker so the local-stub URLs (127.0.0.1:<random>) pass
// the SSRF check by default.
process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'true';
process.env.WEBHOOK_DELIVERY_INTERVAL_MS = '50';

const http = require('http');
const { db } = require('../../src/database/db');
const webhookService = require('../../src/services/webhookService');
const { __test, startWebhookDeliveryWorker, stopWebhookDeliveryWorker } = require('../../src/services/webhookDeliveryWorker');

// Local-only test stub: matches what dev/webhook-receiver/server.js does
// in the docker-compose flow but spun up inside the Jest process so the
// suite is self-contained.
function makeStub({ status = 200, delayMs = 0, bodyOverride = null } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(bodyOverride !== null ? bodyOverride : (status >= 200 && status < 300 ? 'ok' : 'forced'));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function insertWebhook(url, events = ['event.published'], extras = {}) {
  // Tests need the WORKER to bypass SSRF on 127.0.0.1 stubs, but the
  // route layer's allowlist check is bypassed here since we insert
  // straight into the DB.
  const { plaintext, preview } = webhookService.generateSecret();
  const insert = await db('webhooks').insert({
    name: extras.name || 'test',
    url,
    secret: plaintext,
    secret_preview: preview,
    events: JSON.stringify(events),
    active: extras.active !== false,
    created_by: 1,
  }).returning('id');
  const id = insert[0]?.id || insert[0];
  return { id, secret: plaintext };
}

async function clearWebhooks() {
  await db('webhook_deliveries').del();
  await db('webhooks').del();
}

describe('webhook delivery worker (#327)', () => {
  beforeAll(async () => {
    // Schema is expected to already be applied by `npm run migrate`. We
    // just verify the webhooks tables exist; if not, the test harness has
    // missed running migration 082.
    const ok = await db.schema.hasTable('webhooks');
    if (!ok) throw new Error('webhooks table missing — run `npm run migrate` first');
  }, 30000);

  afterAll(async () => {
    stopWebhookDeliveryWorker();
    await db.destroy();
  });

  beforeEach(async () => {
    await clearWebhooks();
  });

  test('signs the body with HMAC-SHA256 and the receiver can verify', async () => {
    const stub = await makeStub({ status: 200 });
    try {
      const { id, secret } = await insertWebhook(stub.url);
      await webhookService.fire('event.published', { event: { id: 1, slug: 'sig-test' } });
      await __test.tick();

      expect(stub.requests).toHaveLength(1);
      const got = stub.requests[0];
      const sig = got.headers['x-picpeak-signature'];
      expect(sig).toBeTruthy();
      // Receiver-side verification using the SAME helper we ship in the README.
      expect(webhookService.verifySignature(secret, got.body, sig)).toBe(true);
      // Tampering must fail.
      expect(webhookService.verifySignature(secret, got.body + 'x', sig)).toBe(false);

      const row = await db('webhook_deliveries').where({ webhook_id: id }).first();
      expect(row.status).toBe('success');
      expect(row.attempt_count).toBe(1);
      expect(row.response_status).toBe(200);
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    } finally {
      await stub.close();
    }
  });

  test('headers include event type and a unique delivery id', async () => {
    const stub = await makeStub({ status: 200 });
    try {
      await insertWebhook(stub.url, ['photo.uploaded']);
      await webhookService.fire('photo.uploaded', { photo: { id: 7 } });
      await __test.tick();

      const got = stub.requests[0];
      expect(got.headers['x-picpeak-event']).toBe('photo.uploaded');
      expect(got.headers['x-picpeak-delivery']).toBeTruthy();
      expect(got.headers['user-agent']).toMatch(/PicPeak-Webhooks/);
    } finally {
      await stub.close();
    }
  });

  test('on 5xx, schedules a retry with exponential backoff and stays pending', async () => {
    const stub = await makeStub({ status: 500 });
    try {
      const { id } = await insertWebhook(stub.url);
      await webhookService.fire('event.published', { event: { id: 2 } });
      await __test.tick();

      const row = await db('webhook_deliveries').where({ webhook_id: id }).first();
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(1);
      expect(row.response_status).toBe(500);
      // BACKOFF_MS[0] = 60s; next_retry_at should be ~60s in the future.
      const dueIn = new Date(row.next_retry_at).getTime() - Date.now();
      expect(dueIn).toBeGreaterThan(50_000);
      expect(dueIn).toBeLessThan(70_000);
    } finally {
      await stub.close();
    }
  });

  test('after MAX_ATTEMPTS failures, status flips to failed and the row is closed', async () => {
    const stub = await makeStub({ status: 500 });
    try {
      const { id } = await insertWebhook(stub.url);
      // Pre-seed a delivery already at attempt_count = 4 so a single tick
      // takes it to 5 → failed (avoids waiting through backoffs).
      await db('webhook_deliveries').insert({
        webhook_id: id,
        event_type: 'event.published',
        payload: JSON.stringify({ id: 'd1', type: 'event.published', data: {} }),
        attempt_count: 4,
        status: 'pending',
        next_retry_at: new Date(),
        created_at: new Date(),
      });
      await __test.tick();

      const row = await db('webhook_deliveries').where({ webhook_id: id }).first();
      expect(row.status).toBe('failed');
      expect(row.attempt_count).toBe(5);
      expect(row.completed_at).toBeTruthy();
      expect(row.next_retry_at).toBeNull();
    } finally {
      await stub.close();
    }
  });

  test('truncates response body to 1KB before storing', async () => {
    const big = 'x'.repeat(5000);
    const stub = await makeStub({ status: 200, bodyOverride: big });
    try {
      const { id } = await insertWebhook(stub.url);
      await webhookService.fire('event.published', { event: {} });
      await __test.tick();

      const row = await db('webhook_deliveries').where({ webhook_id: id }).first();
      expect(row.status).toBe('success');
      expect(Buffer.byteLength(row.response_body || '', 'utf8')).toBeLessThanOrEqual(1024);
    } finally {
      await stub.close();
    }
  });

  test('does not deliver to disabled webhooks (post-mortem state captured)', async () => {
    const stub = await makeStub({ status: 200 });
    try {
      const { id } = await insertWebhook(stub.url, ['event.published'], { active: false });
      // fire enqueues regardless of active state at fire-time, but we
      // disabled BEFORE firing so nothing is enqueued. Direct insert to
      // exercise the worker's mid-flight disable check:
      await db('webhook_deliveries').insert({
        webhook_id: id,
        event_type: 'event.published',
        payload: JSON.stringify({ id: 'd1', type: 'event.published', data: {} }),
        attempt_count: 0,
        status: 'pending',
        next_retry_at: new Date(),
        created_at: new Date(),
      });
      await __test.tick();

      expect(stub.requests).toHaveLength(0);
      const row = await db('webhook_deliveries').where({ webhook_id: id }).first();
      expect(row.status).toBe('failed');
      expect(row.last_error).toMatch(/disabled/i);
    } finally {
      await stub.close();
    }
  });

  test('rejects loopback URLs when WEBHOOK_ALLOW_PRIVATE_URLS=false', async () => {
    __test.setAllowPrivateUrls(false);
    try {
      const { id } = await insertWebhook('http://127.0.0.1:9/');
      await db('webhook_deliveries').insert({
        webhook_id: id,
        event_type: 'event.published',
        payload: JSON.stringify({ id: 'd1', type: 'event.published', data: {} }),
        attempt_count: 0,
        status: 'pending',
        next_retry_at: new Date(),
        created_at: new Date(),
      });
      await __test.tick();

      const row = await db('webhook_deliveries').where({ webhook_id: id }).first();
      expect(row.status).toBe('failed');
      expect(row.last_error).toMatch(/private|internal/i);
    } finally {
      __test.setAllowPrivateUrls(true);
    }
  });

  test('worker can be started + stopped without leaking timers', async () => {
    startWebhookDeliveryWorker();
    startWebhookDeliveryWorker(); // idempotent
    stopWebhookDeliveryWorker();
    stopWebhookDeliveryWorker(); // idempotent
    // If timers leaked the test runner would warn after force-exit; assertion
    // is just "no throw".
    expect(true).toBe(true);
  });
});
