import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';

async function ensureGalleryWithPhotos(page) {
  const loginResponse = await page.request.post('/api/auth/admin/login', {
    data: {
      username: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    },
    failOnStatusCode: false,
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { token } = await loginResponse.json();
  expect(token).toBeTruthy();

  const eventName = `Playwright MCP ${Date.now()}`;
  const eventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const createResponse = await page.request.post('/api/admin/events', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: {
      event_type: 'wedding',
      event_name: eventName,
      event_date: eventDate,
      customer_name: 'Playwright Host',
      customer_email: 'host@example.com',
      admin_email: ADMIN_EMAIL,
      password: GALLERY_PASSWORD,
      expiration_days: 90,
      allow_user_uploads: false,
      allow_downloads: true,
      disable_right_click: false,
      watermark_downloads: false,
      feedback_enabled: true,
      allow_ratings: true,
      allow_likes: true,
      allow_comments: true,
      allow_favorites: true,
      require_name_email: false,
      moderate_comments: false,
      show_feedback_to_guests: true,
    },
    failOnStatusCode: false,
  });

  expect(createResponse.ok()).toBeTruthy();
  const createdEvent = await createResponse.json();
  expect(createdEvent?.id).toBeTruthy();

  const imagePaths = ['img1.png', 'img2.png'].map((file) =>
    path.join(process.cwd(), 'test-assets', file)
  );

  for (const imagePath of imagePaths) {
    const buffer = fs.readFileSync(imagePath);
    const uploadResponse = await page.request.post(
      `/api/admin/events/${createdEvent.id}/upload`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        multipart: {
          photos: {
            name: path.basename(imagePath),
            mimeType: 'image/png',
            buffer,
          },
          category_id: 'individual',
        },
        failOnStatusCode: false,
      }
    );
    expect(uploadResponse.ok()).toBeTruthy();
  }

  return {
    shareLink: createdEvent.share_link,
    slug: createdEvent.slug,
  };
}

test.describe('Gallery grid tile quick actions', () => {
  test('Each tile: open, download, comment, like with immediate UI', async ({ page }) => {
    const { shareLink } = await ensureGalleryWithPhotos(page);

    await page.goto(shareLink);
    const gallery = page;
    await gallery.waitForLoadState('domcontentloaded');
    await gallery.waitForURL(/\/gallery\//);

    const passwordField = gallery.getByPlaceholder(/gallery password/i).first();
    if (await passwordField.count()) {
      await passwordField.fill(GALLERY_PASSWORD);
      try {
        await gallery.getByRole('button', { name: /View Gallery/i }).click({ noWaitAfter: true, timeout: 5000 });
      } catch {
        // Auto-auth via share token may have already navigated to gallery view
      }
      await gallery.waitForLoadState('networkidle');
    }

    // Ensure grid tiles rendered
    const tiles = gallery.locator('.relative.group');
    await expect(tiles.first()).toBeVisible({ timeout: 20000 });

    const tileCount = await tiles.count();
    expect(tileCount).toBeGreaterThan(0);

    // Limit to a few tiles to keep test time sensible
    const N = Math.min(tileCount, 3);
    for (let i = 0; i < N; i++) {
      const tile = tiles.nth(i);
      await tile.scrollIntoViewIfNeeded();
      // On desktop, actions show on hover
      await tile.hover({ force: true });

      // Actions should be present
      const openBtn = tile.getByRole('button', { name: /View full size/i });
      await expect(openBtn).toBeVisible();

      const likeBtn = tile.getByRole('button', { name: /Like photo/i }).first();
      await expect(likeBtn).toBeVisible();

      const commentBtn = tile.getByRole('button', { name: /Comment on photo|Comment/i }).first();
      await expect(commentBtn).toBeVisible();

      const downloadBtn = tile.getByRole('button', { name: /Download photo/i }).first();
      await expect(downloadBtn).toBeVisible();

      // Like should toggle to red and indicator appear immediately
      const pressedBefore = await likeBtn.getAttribute('aria-pressed');
      await likeBtn.click();
      await expect.poll(async () => (await likeBtn.getAttribute('aria-pressed')) || '').toContain('true');
      // Feedback indicator (title="Liked") should appear on the tile
      await expect(tile.locator('[title="Liked"]')).toBeVisible();

      // Open lightbox
      await openBtn.click();
      const closeLightboxBtn = gallery.getByRole('button', { name: /^Close$/i }).first();
      await expect(closeLightboxBtn).toBeVisible();
      // Close again to continue
      await closeLightboxBtn.click();

      // Comment quick action should open lightbox with feedback panel visible
      await tile.hover({ force: true });
      await commentBtn.click();
      await expect(gallery.getByRole('button', { name: /Toggle feedback/ })).toBeVisible();

      // Ensure feedback panel is visible or open it
      const feedbackHeading = gallery.getByRole('heading', { name: /Photo Feedback/i });
      if (!(await feedbackHeading.isVisible())) {
        await gallery.getByRole('button', { name: /Toggle feedback/ }).click();
      }
      await expect(feedbackHeading).toBeVisible();

      // Comments quick action should surface the feedback tools
      const addCommentBtn = gallery.getByRole('button', { name: /Add Comment|Add comment/i });
      await expect(addCommentBtn).toBeVisible();
      await addCommentBtn.click();
      // Allow UI to react without requiring text entry
      await gallery.waitForTimeout(250);

      // Close lightbox to continue (we do not submit to keep test idempotent)
      await closeLightboxBtn.click();

      // Download from tile should trigger a browser download event
      await tile.hover({ force: true });
      const downloadPromise = gallery.waitForEvent('download');
      await downloadBtn.click();
      const download = await downloadPromise;
      expect((await download.path()) !== null).toBeTruthy();
    }
  });
});
