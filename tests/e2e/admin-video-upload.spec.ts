import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';

async function getAdminToken(page: Page): Promise<string> {
  const res = await page.request.post('/api/auth/admin/login', {
    data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok()).toBeTruthy();
  const { token } = await res.json();
  return token;
}

test.describe('Admin video upload (#203)', () => {
  test('Videos uploaded via admin have correct media_type and mime_type', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip();
    }

    const token = await getAdminToken(page);

    // Create event
    const eventName = `PW Video ${Date.now()}`;
    const eventDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const createRes = await page.request.post('/api/admin/events', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        event_type: 'wedding',
        event_name: eventName,
        event_date: eventDate,
        customer_name: 'Playwright Host',
        customer_email: 'host@example.com',
        admin_email: ADMIN_EMAIL,
        password: GALLERY_PASSWORD,
        expiration_days: 90,
        allow_downloads: true,
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const event = await createRes.json();
    expect(event.id).toBeTruthy();

    // Upload a video via admin endpoint
    const videoPath = path.join(process.cwd(), 'test-assets', 'test-video.mp4');
    expect(fs.existsSync(videoPath)).toBeTruthy();
    const buffer = fs.readFileSync(videoPath);

    const uploadRes = await page.request.post(`/api/admin/events/${event.id}/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        photos: { name: 'test-video.mp4', mimeType: 'video/mp4', buffer },
        category_id: 'individual',
      },
    });
    expect(uploadRes.ok()).toBeTruthy();
    const uploadBody = await uploadRes.json();
    expect(uploadBody.successCount).toBeGreaterThanOrEqual(1);

    // Wait for background processing
    await page.waitForTimeout(5000);

    // Fetch photos for this event via admin API
    const photosRes = await page.request.get(`/api/admin/photos/${event.id}/photos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(photosRes.ok()).toBeTruthy();
    const photosBody = await photosRes.json();
    const photos = photosBody.photos || photosBody;
    expect(photos.length).toBeGreaterThanOrEqual(1);

    // Find our video — the critical fix: media_type and mime_type must be set
    const video = photos.find((p: any) => p.media_type === 'video');
    expect(video).toBeTruthy();
    expect(video.media_type).toBe('video');
    expect(video.mime_type).toBe('video/mp4');
    // width/height/duration depend on ffprobe being available in the environment;
    // if present they should be positive, but we don't fail on missing ffprobe
    if (video.width !== null) {
      expect(video.width).toBeGreaterThan(0);
      expect(video.height).toBeGreaterThan(0);
    }

    // Also upload an image and verify it gets media_type = 'image' with dimensions
    const imgBuffer = fs.readFileSync(path.join(process.cwd(), 'test-assets', 'img1.png'));
    const imgUploadRes = await page.request.post(`/api/admin/events/${event.id}/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        photos: { name: 'img1.png', mimeType: 'image/png', buffer: imgBuffer },
        category_id: 'individual',
      },
    });
    expect(imgUploadRes.ok()).toBeTruthy();

    await page.waitForTimeout(2000);

    // Re-fetch and verify image has correct media_type and dimensions
    const photosRes2 = await page.request.get(`/api/admin/photos/${event.id}/photos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(photosRes2.ok()).toBeTruthy();
    const photosBody2 = await photosRes2.json();
    const photos2 = photosBody2.photos || photosBody2;

    const image = photos2.find((p: any) => p.media_type === 'image');
    expect(image).toBeTruthy();
    expect(image.media_type).toBe('image');
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
  });
});
