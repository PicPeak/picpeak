import { expect, type APIRequestContext } from '@playwright/test';

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

/**
 * Log in through the API and return the admin JWT for Bearer headers.
 *
 * The login response body carries only `{ user }`; the token is set as the
 * httpOnly `admin_token` cookie, so it is read back from the request
 * context's cookie jar. That context keeps sending the cookie too.
 */
export async function adminApiToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/admin/login', {
    data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok(), `admin login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const { cookies } = await request.storageState();
  const token = cookies.find((c) => c.name === 'admin_token')?.value;
  expect(token, 'admin_token cookie missing from the login response').toBeTruthy();
  return token as string;
}

/**
 * Publish an event created through the API. New events start as drafts, and a
 * draft's share link shows guests "Gallery Not Found". notify_customer=false
 * keeps the publish from queueing a customer email.
 */
export async function publishEvent(request: APIRequestContext, token: string, eventId: number): Promise<void> {
  const res = await request.post(`/api/admin/events/${eventId}/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { notify_customer: false },
  });
  expect(res.ok(), `publish failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/**
 * Wait until every photo of an event has finished processing. Uploads return
 * 202 with the photo still `pending`, and guests only see `complete` photos,
 * so a gallery opened straight after an upload shows "No photos found".
 */
export async function waitForPhotosProcessed(
  request: APIRequestContext,
  token: string,
  eventId: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let statuses: string[] = [];
  while (Date.now() < deadline) {
    const res = await request.get(`/api/admin/photos/${eventId}/photos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok(), `photo list failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    statuses = (body.photos || body).map((p: { processing_status?: string }) => p.processing_status || 'complete');
    expect(statuses, 'a photo failed processing').not.toContain('failed');
    if (statuses.length > 0 && statuses.every((s) => s === 'complete')) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`photos of event ${eventId} still processing after ${timeoutMs}ms: ${statuses.join(', ')}`);
}
