/**
 * Customer portal end-to-end flow (#354).
 *
 * Covers the maintainer-flagged "core promise" of the feature:
 * a customer can log in once and open every assigned gallery without
 * re-entering the per-event password. Specifically:
 *
 *   1. Admin enables the customerPortal feature flag (Settings → Features).
 *   2. Admin creates an event AND invites a customer to that event.
 *   3. Customer accepts the invitation (sets a password).
 *   4. Customer logs in.
 *   5. Customer's dashboard lists the assigned gallery.
 *   6. Customer clicks the gallery → lands on /gallery/<slug> WITHOUT
 *      seeing a password prompt. The grid renders with photos.
 *
 * The flag no longer locks customers out when switched off (see
 * backend/src/routes/customerAuth.js), so there is no kill-switch check.
 *
 * Needs a backend started with PICPEAK_ECHO_INVITE_TOKEN=1, which
 * docker-compose.e2e.yml sets.
 *
 * Hits the API directly for setup (admin login, event create, photo upload,
 * customer invite, accept-invite, gallery assignment) and only uses the
 * browser for the parts that genuinely need the SPA: the gallery handoff
 * itself, where the bug surface lives. Keeps the spec fast and avoids
 * DOM-fragility on every admin form field.
 */

import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { publishEvent, waitForPhotosProcessed } from './_helpers/admin';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'CustomerPortalGallery!1';
const CUSTOMER_PASSWORD = 'CustomerPortalUser!1';

async function adminLogin(page: Page): Promise<string> {
  const res = await page.request.post('/api/auth/admin/login', {
    data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    failOnStatusCode: false,
  });
  expect(res.ok()).toBeTruthy();
  // The admin JWT is delivered as the httpOnly `admin_token` cookie, not in
  // the response body. Server-side the cookie and an Authorization: Bearer
  // header are interchangeable, so read it back out of the context jar and
  // keep threading it as a Bearer — every downstream call stays as it was.
  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === 'admin_token')?.value;
  expect(token, 'admin_token cookie missing from the login response').toBeTruthy();
  return token as string;
}

async function setFlags(page: Page, adminToken: string, flags: Record<string, boolean>) {
  const res = await page.request.put('/api/admin/feature-flags', {
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    data: flags,
    failOnStatusCode: false,
  });
  expect(res.ok(), `feature flag update failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function setCustomerPortalEnabled(page: Page, adminToken: string, enabled: boolean) {
  await setFlags(page, adminToken, { customerPortal: enabled });
}

/**
 * A real, parseable PDF. The upload is inspected by utils/pdfValidation
 * (#1444), which loads the document rather than sniffing its first bytes —
 * a hand-written `%PDF-` stub is refused, correctly.
 */
function onePagePdf(): Buffer {
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>endobj',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += `${obj}\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function createEventWithPhoto(page: Page, adminToken: string) {
  const eventName = `Customer Portal E2E ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const eventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const createRes = await page.request.post('/api/admin/events', {
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      event_type: 'wedding',
      event_name: eventName,
      event_date: eventDate,
      customer_name: 'Customer Portal Host',
      customer_email: 'host@example.com',
      admin_email: ADMIN_EMAIL,
      password: GALLERY_PASSWORD,
      expiration_days: 30,
      allow_user_uploads: false,
      allow_downloads: true,
    },
    failOnStatusCode: false,
  });
  if (!createRes.ok()) {
    throw new Error(`Event create failed: ${createRes.status()} ${await createRes.text()}`);
  }
  const event = await createRes.json();
  await publishEvent(page.request, adminToken, event.id);

  // One photo so the gallery grid has something to render after the
  // customer hits it. Tests that the gallery loads, not that it's empty.
  const imagePath = path.join(process.cwd(), 'test-assets', 'img1.png');
  const buffer = fs.readFileSync(imagePath);
  const uploadRes = await page.request.post(`/api/admin/events/${event.id}/upload`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    multipart: {
      photos: { name: 'img1.png', mimeType: 'image/png', buffer },
      category_id: 'individual',
    },
    failOnStatusCode: false,
  });
  expect(uploadRes.ok()).toBeTruthy();
  await waitForPhotosProcessed(page.request, adminToken, event.id);

  return event;
}

/**
 * Invite a customer, accept the invitation, return the email.
 *
 * The admin invite response echoes `invitation.token` only when
 * NODE_ENV !== 'production' — that lets the spec skip the email
 * round-trip without needing a separate /admin/email-queue endpoint
 * or direct DB access. In production the token stays email-only.
 */
async function inviteAndAcceptCustomer(page: Page, adminToken: string) {
  const email = `customer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

  const inviteRes = await page.request.post('/api/admin/customers/invite', {
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    data: { email },
    failOnStatusCode: false,
  });
  if (!inviteRes.ok()) {
    throw new Error(`Customer invite failed: ${inviteRes.status()} ${await inviteRes.text()}`);
  }
  const inviteBody = await inviteRes.json();
  // successResponse wraps in { success, data } — accept either shape.
  const invitation = inviteBody.data?.invitation ?? inviteBody.invitation;
  expect(invitation?.token, 'expected invitation.token echoed from non-prod /invite response').toBeTruthy();
  const token = invitation.token;

  // Accept the invitation as the customer (no auth).
  const acceptRes = await page.request.post('/api/customer/auth/accept-invite', {
    headers: { 'Content-Type': 'application/json' },
    data: {
      token,
      name: 'Customer Portal E2E',
      password: CUSTOMER_PASSWORD,
    },
    failOnStatusCode: false,
  });
  if (!acceptRes.ok()) {
    throw new Error(`Accept failed: ${acceptRes.status()} ${await acceptRes.text()}`);
  }

  return { email };
}

async function getCustomerIdByEmail(page: Page, adminToken: string, email: string): Promise<number> {
  const res = await page.request.get(`/api/admin/customers?search=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    failOnStatusCode: false,
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const list = body.customers || body.data?.customers || body;
  const match = (Array.isArray(list) ? list : []).find((c: any) => c.email === email);
  expect(match, `expected customer with email ${email}`).toBeTruthy();
  return match.id;
}

async function assignCustomerToEvent(page: Page, adminToken: string, eventId: number, customerId: number) {
  // Update the event to include this customer's id in customer_account_ids
  const res = await page.request.put(`/api/admin/events/${eventId}`, {
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    data: { customer_account_ids: [customerId] },
    failOnStatusCode: false,
  });
  if (!res.ok()) {
    throw new Error(`Customer assignment failed: ${res.status()} ${await res.text()}`);
  }
}

// ---- the actual spec ---------------------------------------------------

test.describe('Customer portal — login + gallery handoff', () => {
  test.beforeEach(async ({ page }) => {
    // Make sure each test starts with a clean cookie jar so a leftover
    // admin_token from a previous spec doesn't accidentally satisfy
    // /api/customer/auth/session via the Authorization-Bearer fallback
    // (which the customer-side specifically refuses, but the test
    // shouldn't rely on that to pass).
    await page.context().clearCookies();
  });

  test('customer can log in and open an assigned gallery without a password', async ({ page }) => {
    // === setup (admin side) ===
    const adminToken = await adminLogin(page);
    await setCustomerPortalEnabled(page, adminToken, true);

    const event = await createEventWithPhoto(page, adminToken);
    const { email } = await inviteAndAcceptCustomer(page, adminToken);
    const customerId = await getCustomerIdByEmail(page, adminToken, email);
    await assignCustomerToEvent(page, adminToken, event.id, customerId);

    try {
      // === customer flow ===
      // Login through the SPA (covers the cookie + setSession path that
      // makes the dashboard render the assigned gallery on first paint).
      await page.context().clearCookies();
      await page.goto('/customer/login');
      await page.getByLabel(/Email/i).fill(email);
      // Role, not label: the "Show password" toggle matches /Password/ too.
      await page.getByRole('textbox', { name: 'Password' }).fill(CUSTOMER_PASSWORD);
      await page.getByRole('button', { name: /Sign in/i }).click();

      // Dashboard should list the assigned event by name.
      // The portal switches to the customer's preferred language after login,
      // which a fresh invite can leave on German.
      await expect(page.getByRole('heading', { name: /Your galleries|Ihre Galerien/i })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(event.event_name, { exact: false })).toBeVisible({ timeout: 15000 });

      // Click → gallery handoff. Watch for the URL change AND the absence
      // of the per-event password prompt. Either of those failing is the
      // primary regression this spec is designed to catch.
      const navPromise = page.waitForURL(/\/gallery\//, { timeout: 15000 });
      await page.getByRole('button', { name: /Open gallery|Galerie .* öffnen/i }).first().click();
      await navPromise;

      // The password prompt would render `Enter Gallery Password` (heading
      // or section label). It must NOT be present after the customer
      // dashboard handoff.
      await expect(page.getByText(/Enter Gallery Password/i)).toHaveCount(0);

      // The grid tiles use the `.relative.group` selector across layouts;
      // matches `auth-smoke.spec.ts`. At least one must render.
      const tiles = page.locator('.relative.group');
      await expect(tiles.first()).toBeVisible({ timeout: 20000 });
    } finally {
      // Clean up: turn the feature off so the next test starts from a
      // known state. Errors are swallowed — leftover state from a failed
      // run is something to investigate manually.
      await setCustomerPortalEnabled(page, adminToken, false).catch(() => { /* noop */ });
    }
  });

  /**
   * Documents, end to end (#1444 plan slice 11).
   *
   * The jest suite pins each step against the routers; this pins that the
   * steps join up in a browser, through the real gates: an upload is not
   * downloadable until an admin has reviewed it, and once reviewed it is.
   */
  test('a customer uploads a document, waits for review, then downloads it', async ({ page }) => {
    const adminToken = await adminLogin(page);
    await setFlags(page, adminToken, { customerPortal: true, documents: true });
    const { email } = await inviteAndAcceptCustomer(page, adminToken);
    const customerId = await getCustomerIdByEmail(page, adminToken, email);

    try {
      await page.context().clearCookies();
      await page.goto('/customer/login');
      await page.getByLabel(/Email/i).fill(email);
      await page.getByRole('textbox', { name: 'Password' }).fill(CUSTOMER_PASSWORD);
      await page.getByRole('button', { name: /Sign in/i }).click();
      // Not `toHaveURL(/\/customer\//)`: /customer/login matches that too, so
      // a failed sign-in would sail past it and fail later somewhere vaguer.
      await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 });

      await page.goto('/customer/documents');
      await page.getByLabel(/PDF file|PDF-Datei/i).setInputFiles({
        name: 'signed-contract.pdf',
        mimeType: 'application/pdf',
        buffer: onePagePdf(),
      });
      await page.getByRole('button', { name: /^Upload|Hochladen/i }).click();

      // Received, and explicitly NOT available: the review is the gate.
      // `exact`, because the success message names the file too — and the
      // portal may be in German here, since a fresh invite leaves the
      // customer's preferred language unset.
      await expect(page.getByText('signed-contract.pdf', { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(/Awaiting review|Wird geprüft/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /Download signed-contract\.pdf/i })).toHaveCount(0);

      // The admin finds it and marks it clean.
      const list = await page.request.get(`/api/admin/customers/${customerId}/documents`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        failOnStatusCode: false,
      });
      expect(list.ok(), `admin document list failed: ${list.status()}`).toBeTruthy();
      const body = await list.json();
      const documents = body.data?.documents ?? body.documents;
      const uploaded = documents.find((d: any) => d.name === 'signed-contract.pdf');
      expect(uploaded, 'the upload should be on the admin list').toBeTruthy();
      expect(uploaded.status).toBe('pending');

      const review = await page.request.post(
        `/api/admin/customers/${customerId}/documents/${uploaded.id}/review`,
        {
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          data: { status: 'clean' },
          failOnStatusCode: false,
        },
      );
      expect(review.ok(), `review failed: ${review.status()} ${await review.text()}`).toBeTruthy();

      // …and now the customer can take it back, as an attachment.
      await page.reload();
      await expect(page.getByText(/Available|Verfügbar/i)).toBeVisible({ timeout: 15000 });
      const download = await page.request.get(`/api/customer/documents/${uploaded.id}/download`, {
        failOnStatusCode: false,
      });
      expect(download.status()).toBe(200);
      expect(download.headers()['content-disposition']).toMatch(/^attachment;/);
      expect(download.headers()['x-content-type-options']).toBe('nosniff');
      expect((await download.body()).subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      await setFlags(page, adminToken, { customerPortal: false, documents: false })
        .catch(() => { /* noop */ });
    }
  });
});
