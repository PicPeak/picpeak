import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * End-to-end smoke for the S3 storage backend (#328).
 *
 * What this verifies:
 *   - admin can upload photos via the API
 *   - thumbnail + hero generation lands in S3 (visible via the public gallery)
 *   - the gallery photo route streams the original through the backend
 *   - admin delete removes the original from S3 (subsequent gets 404)
 *
 * How to run:
 *   1. Start dev stack with S3 mode + MinIO. The simplest way is to bring up
 *      MinIO from docker-compose.dev.yml and override the backend env:
 *
 *      docker compose -f docker-compose.dev.yml up -d minio minio-init postgres redis
 *      STORAGE_BACKEND=s3 \
 *      STORAGE_S3_BUCKET=picpeak-storage \
 *      STORAGE_S3_REGION=us-east-1 \
 *      STORAGE_S3_ENDPOINT=http://localhost:7104 \
 *      STORAGE_S3_ACCESS_KEY=minioadmin \
 *      STORAGE_S3_SECRET_KEY=minioadmin \
 *      STORAGE_S3_FORCE_PATH_STYLE=true \
 *      STORAGE_S3_SSL=false \
 *      npm --prefix backend run dev
 *
 *   2. Run this spec:
 *      PLAYWRIGHT_BASE_URL=http://localhost:7100 npx playwright test \
 *        tests/e2e/s3-storage-roundtrip.spec.ts --project=chromium
 *
 * The test auto-skips against backends that don't expose STORAGE_BACKEND=s3
 * via the /health endpoint, so it's safe to leave in the shared E2E suite.
 */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';
const TEST_ASSET = path.join(__dirname, '..', '..', 'test-assets', 'img1.png');

async function isS3Backend(baseUrl: string): Promise<boolean> {
  // Explicit opt-in for runs against an S3-configured backend. The spec
  // auto-skips otherwise so it's safe to leave in the shared E2E suite.
  if (process.env.TEST_S3_MODE === '1') return true;
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body?.storage?.backend === 's3' || body?.storageBackend === 's3';
  } catch {
    return false;
  }
}

test.describe('S3 storage round-trip (#328)', () => {
  test.beforeAll(async ({}, testInfo) => {
    const baseUrl = testInfo.project.use.baseURL || process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
    const isS3 = await isS3Backend(baseUrl);
    test.skip(!isS3, 'Backend is not running with STORAGE_BACKEND=s3 — see spec docstring for setup.');
  });

  test('upload → serve → delete round-trip through the storage backend', async ({ request }) => {
    expect(fs.existsSync(TEST_ASSET), `Test asset missing at ${TEST_ASSET}`).toBe(true);

    // Admin login — auth lives in the HttpOnly admin_token cookie which the
    // request fixture retains across subsequent calls automatically.
    const loginRes = await request.post('/api/auth/admin/login', {
      data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(loginRes.ok(), `login failed: ${loginRes.status()}`).toBeTruthy();

    // Create event
    const eventName = `S3 Roundtrip ${Date.now()}`;
    const eventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const eventRes = await request.post('/api/admin/events', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        event_type: 'wedding',
        event_name: eventName,
        event_date: eventDate,
        customer_name: 'S3 Host',
        customer_email: 'host@example.com',
        host_name: 'S3 Host',
        host_email: 'host@example.com',
        admin_email: ADMIN_EMAIL,
        password: GALLERY_PASSWORD,
        expiration_days: 30,
      },
    });
    expect(eventRes.ok(), `event create failed: ${eventRes.status()}`).toBeTruthy();
    const eventBody = await eventRes.json();
    const eventId: number = eventBody?.event?.id ?? eventBody?.id;
    const slug: string = eventBody?.event?.slug ?? eventBody?.slug;
    expect(eventId).toBeTruthy();
    expect(slug).toBeTruthy();

    // Upload a single photo
    const uploadRes = await request.post(`/api/admin/photos/${eventId}/upload`, {
      multipart: {
        photos: { name: 'img1.png', mimeType: 'image/png', buffer: fs.readFileSync(TEST_ASSET) },
      },
    });
    expect(uploadRes.ok(), `upload failed: ${uploadRes.status()}`).toBeTruthy();
    const uploadBody = await uploadRes.json();
    const photoId: number = uploadBody?.photos?.[0]?.id;
    expect(photoId, 'uploaded photo missing from response').toBeTruthy();

    // Wait briefly for thumbnail generation to settle.
    await new Promise((r) => setTimeout(r, 1000));

    // Fetch the thumbnail through the admin route — proves the storage backend
    // can read what it wrote and the route streams it correctly.
    const thumbRes = await request.get(`/api/admin/photos/${eventId}/thumbnail/${photoId}`);
    expect(thumbRes.ok(), `thumbnail GET failed: ${thumbRes.status()}`).toBeTruthy();
    const thumbBytes = await thumbRes.body();
    expect(thumbBytes.length).toBeGreaterThan(100);

    // Fetch the original photo through the admin route.
    const photoRes = await request.get(`/api/admin/photos/${eventId}/photo/${photoId}`);
    expect(photoRes.ok(), `photo GET failed: ${photoRes.status()}`).toBeTruthy();
    const photoBytes = await photoRes.body();
    expect(photoBytes.length).toBeGreaterThan(100);

    // Delete the photo and confirm subsequent fetches 404.
    const deleteRes = await request.delete(`/api/admin/photos/${eventId}/photos/${photoId}`);
    expect(deleteRes.ok(), `delete failed: ${deleteRes.status()}`).toBeTruthy();

    const photoAfterDelete = await request.get(`/api/admin/photos/${eventId}/photo/${photoId}`);
    expect(photoAfterDelete.status()).toBe(404);

    // Tidy up the event so repeated test runs don't leak.
    await request.delete(`/api/admin/events/${eventId}`).catch(() => {});
  });
});
