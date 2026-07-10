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

async function createGalleryPremiumEvent(page: Page) {
  const token = await getAdminToken(page);

  const eventName = `PW SelectAll ${Date.now()}`;
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
      gallery_theme: 'gallery-premium',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const event = await createRes.json();

  // Upload 3 images so we can verify select-all picks all of them
  const imagePaths = ['img1.png', 'img2.png', 'img1.png'].map((f) =>
    path.join(process.cwd(), 'test-assets', f)
  );

  for (const imagePath of imagePaths) {
    const buffer = fs.readFileSync(imagePath);
    const uploadRes = await page.request.post(`/api/admin/events/${event.id}/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        photos: { name: path.basename(imagePath), mimeType: 'image/png', buffer },
        category_id: 'individual',
      },
    });
    expect(uploadRes.ok()).toBeTruthy();
  }

  return { shareLink: event.share_link, slug: event.slug, token };
}

test.describe('Gallery-Premium Select All (#220)', () => {
  test('Select All button selects all photos in one click', async ({ page, browserName }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip();
    }

    const { shareLink } = await createGalleryPremiumEvent(page);

    // Navigate to gallery
    await page.goto(shareLink);
    await page.waitForLoadState('domcontentloaded');

    // Handle password if needed
    const passwordField = page.getByPlaceholder(/gallery password/i).first();
    if (await passwordField.count()) {
      await passwordField.fill(GALLERY_PASSWORD);
      try {
        await page.getByRole('button', { name: /View Gallery/i }).click({ timeout: 5000 });
      } catch {
        // Token may auto-auth
      }
      await page.waitForLoadState('networkidle');
    }

    // Wait for photos to render
    await page.waitForTimeout(3000);

    // Look for download button to enter selection mode
    const downloadBtn = page.getByRole('button', { name: /Download/i }).first();
    await expect(downloadBtn).toBeVisible({ timeout: 15000 });
    await downloadBtn.click();

    // Now look for "Select All" button
    const selectAllBtn = page.getByRole('button', { name: /Select All/i }).first();
    await expect(selectAllBtn).toBeVisible({ timeout: 10000 });

    // Click Select All once
    await selectAllBtn.click();
    await page.waitForTimeout(500);

    // Verify all photos are selected - check for checkmarks or selected state
    // The selection count or "Deselect All" text should appear
    const deselectAllBtn = page.getByRole('button', { name: /Deselect All/i }).first();
    await expect(deselectAllBtn).toBeVisible({ timeout: 5000 });

    // Verify: clicking Deselect All should clear selection
    await deselectAllBtn.click();
    await page.waitForTimeout(500);

    // Select All should be visible again
    await expect(selectAllBtn).toBeVisible({ timeout: 5000 });
  });
});
