import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';

async function createEventWithPhotos(page: Page, adminToken?: string, attempt = 1) {
  const api = page.request;
  let token = adminToken;

  if (!token) {
    const loginResponse = await api.post('/api/auth/admin/login', {
      data: {
        username: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      },
    });
    expect(loginResponse.ok()).toBeTruthy();
    const loginData = await loginResponse.json();
    token = loginData.token;
    expect(token).toBeTruthy();
  }

  const eventName = `Playwright Smoke ${Date.now()}`;
  const eventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  if (!token) {
    throw new Error('Failed to acquire admin token');
  }

  const eventResponse = await api.post('/api/admin/events', {
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
      host_name: 'Playwright Host',
      host_email: 'host@example.com',
      admin_email: ADMIN_EMAIL,
      password: GALLERY_PASSWORD,
      expiration_days: 30,
      allow_user_uploads: false,
      allow_downloads: true,
      disable_right_click: false,
      watermark_downloads: false,
    },
  });
  if (!eventResponse.ok()) {
    const message = await eventResponse.text();
    if (
      attempt < 3 &&
      /UNIQUE constraint failed: events\.slug/i.test(message || '')
    ) {
      await page.waitForTimeout(150);
      return createEventWithPhotos(page, token, attempt + 1);
    }
    throw new Error(`Event creation failed: ${eventResponse.status()} ${message}`);
  }
  const event = await eventResponse.json();

  const imagePath = path.join(process.cwd(), 'test-assets', 'img1.png');
  const buffer = fs.readFileSync(imagePath);
  const uploadResponse = await api.post(`/api/admin/events/${event.id}/upload`, {
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
  });
  expect(uploadResponse.ok()).toBeTruthy();

  return {
    event,
    shareLink: event.share_link,
    slug: event.slug,
    adminToken: token,
  };
}

async function updateShortGallerySetting(page: Page, adminToken: string, enabled: boolean) {
  const response = await page.request.put('/api/admin/settings/general', {
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      general_short_gallery_urls: enabled,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function openGalleryShareLink(page: Page, shareLink: string) {
  await page.context().clearCookies();
  await page.goto(shareLink);
  await page.waitForLoadState('domcontentloaded');

  try {
    await page.getByText(/Enter Gallery Password/i).first().waitFor({ timeout: 5000 });
  } catch {
    // No password prompt shown (public gallery)
  }

  let passwordEntered = false;
  const passwordTextbox = page.getByRole('textbox', { name: /password/i }).first();
  if (await passwordTextbox.count()) {
    await passwordTextbox.fill(GALLERY_PASSWORD);
    passwordEntered = true;
  }

  const galleryPasswordField = page.getByPlaceholder(/gallery password/i);
  if (!passwordEntered && await galleryPasswordField.count()) {
    await galleryPasswordField.fill(GALLERY_PASSWORD);
    passwordEntered = true;
  } else if (!passwordEntered) {
    const genericPasswordField = page.getByPlaceholder(/password/i).first();
    if (await genericPasswordField.count()) {
      await genericPasswordField.fill(GALLERY_PASSWORD);
      passwordEntered = true;
    } else {
      const labelledPasswordField = page.getByLabel(/password/i).first();
      if (await labelledPasswordField.count()) {
        await labelledPasswordField.fill(GALLERY_PASSWORD);
        passwordEntered = true;
      }
    }
  }

  if (!passwordEntered) {
    const fallbackPasswordField = page.locator('input').first();
    if (await fallbackPasswordField.count()) {
      await fallbackPasswordField.fill(GALLERY_PASSWORD);
      passwordEntered = true;
    }
  }

  const viewButton = page.getByRole('button', { name: /View Gallery/i });
  if (await viewButton.count()) {
    try {
      await viewButton.click({ noWaitAfter: true, timeout: 2000 });
    } catch {
      // Already navigated into gallery view.
    }
  }

  const tiles = page.locator('.relative.group');
  await expect(tiles.first()).toBeVisible({ timeout: 20000 });
  return tiles;
}

test('admin login and gallery viewing smoke test', async ({ page }) => {
  const { shareLink, adminToken } = await createEventWithPhotos(page);

  // Admin UI login
  await page.goto('/admin/login');
  const emailField = page.getByLabel(/Email/i);
  if (await emailField.count()) {
    await emailField.fill(ADMIN_EMAIL);
    await page.getByLabel(/Password/i).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /Sign In|Log in/i }).click();
  }
  await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({ timeout: 20000 });

  let resetToken = adminToken;
  try {
    // Verify long-form share link works
    const tiles = await openGalleryShareLink(page, shareLink);
    await tiles.first().hover();
    await tiles.first().getByRole('button', { name: /View full size/i }).click();
    await expect(page.getByRole('button', { name: /Close/i })).toBeVisible();
    await page.getByRole('button', { name: /Close/i }).click();

    // Enable short gallery URLs
    await updateShortGallerySetting(page, adminToken, true);

    const settingsResponse = await page.request.get('/api/admin/settings', {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    expect(settingsResponse.ok()).toBeTruthy();
    const adminSettings = await settingsResponse.json();
    expect(adminSettings.general_short_gallery_urls === true || adminSettings.general_short_gallery_urls === 'true').toBeTruthy();

    const { shareLink: shortShareLink, event: shortEvent } = await createEventWithPhotos(page, adminToken);
    expect(shortShareLink).toMatch(/\/gallery\/[0-9a-fA-F]{32}$/);
    expect(shortShareLink).not.toContain(shortEvent.slug);

    // Verify short share link works
    await openGalleryShareLink(page, shortShareLink);

    // Legacy share link should still work after enabling short URLs
    await openGalleryShareLink(page, shareLink);
  } finally {
    await updateShortGallerySetting(page, resetToken, false).catch(() => {
      /* noop */
    });
  }
});
