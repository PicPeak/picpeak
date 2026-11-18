import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { adminApiToken, publishEvent, waitForPhotosProcessed } from './_helpers/admin';
import { passGalleryPasswordPrompt } from './_helpers/gallery';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';

async function getAdminToken(page: Page): Promise<string> {
  return adminApiToken(page.request);
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
      // The layout lives in the event's own theme, which applies only with
      // custom_theme_enabled; otherwise the global Branding theme decides.
      custom_theme_enabled: true,
      color_theme: JSON.stringify({ galleryLayout: 'gallery-premium' }),
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const event = await createRes.json();
  await publishEvent(page.request, token, event.id);

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
  await waitForPhotosProcessed(page.request, token, event.id);

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

    await passGalleryPasswordPrompt(page, GALLERY_PASSWORD);

    // Premium tiles carry a selection checkbox; the Select All control
    // joins the nav once a photo is selected.
    const checkboxes = page.locator('.gallery-premium-checkbox');
    await expect(checkboxes).toHaveCount(3, { timeout: 20000 });
    await checkboxes.first().click({ force: true });

    const selectAllBtn = page.getByRole('button', { name: /^Select All$/i });
    await expect(selectAllBtn).toBeVisible({ timeout: 10000 });

    // One click selects every photo.
    await selectAllBtn.click();
    await expect(page.locator('.gallery-premium-checkbox.selected')).toHaveCount(3);
    const deselectAllBtn = page.getByRole('button', { name: /^Deselect All$/i });
    await expect(deselectAllBtn).toBeVisible({ timeout: 5000 });

    // And Deselect All clears it.
    await deselectAllBtn.click();
    await expect(page.locator('.gallery-premium-checkbox.selected')).toHaveCount(0);
  });
});
