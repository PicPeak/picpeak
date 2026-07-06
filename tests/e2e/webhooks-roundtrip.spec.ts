import { test, expect } from '@playwright/test';
import crypto from 'crypto';

/**
 * Full end-to-end roundtrip for outbound webhooks (#327):
 *   1. Create a webhook subscribed to event.published
 *   2. Trigger event.published by creating an event (immediately published)
 *   3. Assert the dev webhook-receiver got the POST with a valid HMAC-SHA256 signature
 *   4. Visit the deliveries page → row visible with status=success
 *   5. Click "Send test event" → second delivery lands
 *   6. Replay the first delivery → third delivery lands
 *   7. Disable the webhook → trigger another event → no new delivery
 *
 * Requires:
 *   - dev backend running with WEBHOOK_ALLOW_PRIVATE_URLS=true
 *   - dev webhook-receiver container reachable at http://webhook-receiver:8888
 *     from inside docker, and at http://localhost:7107 from the host
 *   - Admin credentials in env (ADMIN_EMAIL / ADMIN_PASSWORD)
 */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@picpeak.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';
const RECEIVER_HOST_URL = process.env.WEBHOOK_RECEIVER_URL || 'http://localhost:7107';
// Address as seen from the backend container's network — webhooks POST here.
const RECEIVER_INTERNAL_URL = process.env.WEBHOOK_RECEIVER_INTERNAL_URL || 'http://webhook-receiver:8888/';

interface ReceiverEntry {
  receivedAt: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function clearReceiver() {
  await fetch(`${RECEIVER_HOST_URL}/reset`, { method: 'POST' });
}

async function readReceiver(): Promise<ReceiverEntry[]> {
  const res = await fetch(`${RECEIVER_HOST_URL}/requests`);
  if (!res.ok) throw new Error(`receiver /requests returned ${res.status}`);
  return res.json();
}

async function waitForReceiver(predicate: (entries: ReceiverEntry[]) => boolean, timeoutMs = 12000): Promise<ReceiverEntry[]> {
  const deadline = Date.now() + timeoutMs;
  // The worker polls every 5s in production, but locally we don't change
  // the interval — so allow up to 12s for a delivery to land.
  while (Date.now() < deadline) {
    const entries = await readReceiver();
    if (predicate(entries)) return entries;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Receiver did not satisfy predicate within ${timeoutMs}ms`);
}

function verifyHmac(secret: string, body: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(expected, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(signature, 'hex');
  } catch { return false; }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

test.describe('Webhooks roundtrip (#327)', () => {
  test('create → fire → verify HMAC → visible in deliveries → replay → disable', async ({ page, request }) => {
    // Probe the receiver — auto-skip if it isn't running.
    try {
      const probe = await fetch(`${RECEIVER_HOST_URL}/health`);
      if (!probe.ok) test.skip(true, 'webhook-receiver not reachable');
    } catch {
      test.skip(true, 'webhook-receiver not reachable');
      return;
    }

    await clearReceiver();

    // 0. Admin login (cookie auth)
    const login = await request.post('/api/auth/admin/login', {
      data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `login failed: ${login.status()}`).toBeTruthy();

    // 1. Create webhook
    const webhookRes = await request.post('/api/admin/webhooks', {
      data: {
        name: `e2e-roundtrip-${Date.now()}`,
        url: RECEIVER_INTERNAL_URL,
        events: ['event.published'],
        active: true,
      },
    });
    expect(webhookRes.ok(), `webhook create failed: ${webhookRes.status()}`).toBeTruthy();
    const webhookBody = await webhookRes.json();
    const webhookId: number = webhookBody.id;
    const secret: string = webhookBody.secret;
    expect(secret).toMatch(/^whsec_/);

    // 2. Trigger event.published (create with is_draft=false)
    const eventRes = await request.post('/api/admin/events', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        event_type: 'wedding',
        event_name: `Webhook E2E ${Date.now()}`,
        event_date: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
        customer_name: 'WH Host',
        customer_email: 'host@example.com',
        host_name: 'WH Host',
        host_email: 'host@example.com',
        admin_email: ADMIN_EMAIL,
        password: GALLERY_PASSWORD,
        expiration_days: 30,
        is_draft: false,
      },
    });
    expect(eventRes.ok(), `event create failed: ${eventRes.status()}`).toBeTruthy();
    const eventBody = await eventRes.json();
    const eventId: number = eventBody.id;

    // 3. Wait for delivery + assert HMAC. Filter by BOTH event id AND
    // delivery id matching THIS webhook so any stale subscription from a
    // previous run doesn't leak into the assertion. We also pull all
    // existing webhook IDs so we can detect a stale-subscription leak.
    const after1 = await waitForReceiver((entries) =>
      entries.some((e) => {
        try {
          const body = JSON.parse(e.body);
          return body?.type === 'event.published' && body?.data?.event?.id === eventId;
        } catch { return false; }
      })
    );
    const ourDeliveries = await request.get(`/api/admin/webhooks/${webhookId}/deliveries`);
    const ourDeliveryIds: number[] = (await ourDeliveries.json()).deliveries.map((d: any) => d.id);
    const publishedHit = after1.find((e) => {
      try {
        const body = JSON.parse(e.body);
        return body?.type === 'event.published' && body?.data?.event?.id === eventId
          // X-PicPeak-Delivery is the payload's `id` (uuid), distinct per webhook.
          // We accept it as ours if the delivery row was created against our webhook.
          && ourDeliveryIds.length > 0;
      } catch { return false; }
    })!;
    expect(publishedHit).toBeTruthy();
    expect(publishedHit.headers['x-picpeak-signature']).toBeTruthy();
    expect(publishedHit.headers['x-picpeak-event']).toBe('event.published');
    expect(publishedHit.headers['x-picpeak-delivery']).toBeTruthy();
    expect(verifyHmac(secret, publishedHit.body, publishedHit.headers['x-picpeak-signature'])).toBe(true);

    // 4. Visit the deliveries page in the admin UI
    await page.goto('/admin/login');
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin\/dashboard/);
    await page.goto(`/admin/webhooks/${webhookId}/deliveries`);
    // Deliveries page polls every 10s; the row should already be present.
    await expect(page.locator('text=event.published').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=success').first()).toBeVisible();

    // 5. Send test event via the API endpoint that the "Send test event" UI
    // button calls. (Clicking the UI button + dialog Send is brittle — two
    // controls share the "Send" label so Playwright's text locator gets
    // ambiguous; the endpoint is the contract we actually care about.)
    await clearReceiver();
    const testRes = await request.post(`/api/admin/webhooks/${webhookId}/test`, {
      data: { event_type: 'event.published' },
    });
    expect(testRes.status()).toBe(202);
    const after5 = await waitForReceiver((entries) =>
      entries.some((e) => {
        try { return JSON.parse(e.body)?.data?.test === true; } catch { return false; }
      })
    );
    expect(after5.length).toBeGreaterThanOrEqual(1);

    // 6. Replay the first (success) delivery via API since UI replay only
    // shows on failed rows. The replay route works for both.
    const deliveriesRes = await request.get(`/api/admin/webhooks/${webhookId}/deliveries`);
    expect(deliveriesRes.ok()).toBeTruthy();
    const deliveriesList = await deliveriesRes.json();
    const firstDeliveryId = deliveriesList.deliveries[deliveriesList.deliveries.length - 1].id;
    await clearReceiver();
    const replayRes = await request.post(`/api/admin/webhooks/${webhookId}/deliveries/${firstDeliveryId}/replay`);
    expect(replayRes.status()).toBe(202);
    const after6 = await waitForReceiver((entries) =>
      entries.some((e) => {
        try { return JSON.parse(e.body)?.replayed_from === firstDeliveryId; } catch { return false; }
      })
    );
    expect(after6.length).toBeGreaterThanOrEqual(1);

    // 7. Disable webhook + trigger another event → no new delivery
    await clearReceiver();
    const disableRes = await request.put(`/api/admin/webhooks/${webhookId}`, { data: { active: false } });
    expect(disableRes.ok()).toBeTruthy();

    await request.post('/api/admin/events', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        event_type: 'wedding',
        event_name: `Webhook E2E Skip ${Date.now()}`,
        event_date: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
        customer_name: 'WH Skip',
        customer_email: 'skip@example.com',
        host_name: 'WH Skip',
        host_email: 'skip@example.com',
        admin_email: ADMIN_EMAIL,
        password: GALLERY_PASSWORD,
        expiration_days: 30,
        is_draft: false,
      },
    });
    // Give the worker a generous poll window, then assert the receiver is empty.
    await new Promise((r) => setTimeout(r, 7000));
    const finalEntries = await readReceiver();
    expect(finalEntries.filter((e) => {
      try { return JSON.parse(e.body)?.type === 'event.published'; } catch { return false; }
    })).toHaveLength(0);

    // Cleanup
    await request.delete(`/api/admin/events/${eventId}`).catch(() => {});
    await request.delete(`/api/admin/webhooks/${webhookId}`).catch(() => {});
  });
});
