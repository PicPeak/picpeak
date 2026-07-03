import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';

interface GallerySetupResult {
  shareLink: string;
  slug: string;
  allPhotosData: {
    event: any;
    categories?: any;
    photos: Array<{ id: number; filename: string; comment_count?: number }>;
  };
}

async function createGalleryWithModeratedComments(page: Page): Promise<GallerySetupResult> {
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

  const eventName = `Playwright Feedback Filter ${Date.now()}`;
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
      expiration_days: 30,
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
      moderate_comments: true,
      show_feedback_to_guests: true,
    },
    failOnStatusCode: false,
  });

  expect(createResponse.ok()).toBeTruthy();
  const createdEvent = await createResponse.json();
  expect(createdEvent?.id).toBeTruthy();

  const imagePaths = ['img1.png', 'img2.png'];
  const photoIds: number[] = [];

  for (const file of imagePaths) {
    const imagePath = path.join(process.cwd(), 'test-assets', file);
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
    const uploadJson = await uploadResponse.json();
    const uploaded = uploadJson?.photos?.[0];
    expect(uploaded?.id).toBeTruthy();
    photoIds.push(uploaded.id);
  }

  expect(photoIds.length).toBeGreaterThanOrEqual(2);

  const galleryAuthResponse = await page.request.post('/api/auth/gallery/verify', {
    data: {
      slug: createdEvent.slug,
      password: GALLERY_PASSWORD,
    },
    failOnStatusCode: false,
  });
  expect(galleryAuthResponse.ok()).toBeTruthy();
  const { token: galleryToken } = await galleryAuthResponse.json();
  expect(galleryToken).toBeTruthy();

  // Submit an approved comment (after moderation)
  const approvedCommentResponse = await page.request.post(
    `/api/gallery/${createdEvent.slug}/photos/${photoIds[0]}/feedback`,
    {
      headers: {
        Authorization: `Bearer ${galleryToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        feedback_type: 'comment',
        comment_text: 'Approved comment',
        guest_name: 'Approved Guest',
        guest_email: 'approved@example.com',
      },
      failOnStatusCode: false,
    }
  );
  expect(approvedCommentResponse.ok()).toBeTruthy();
  const approvedComment = await approvedCommentResponse.json();
  expect(approvedComment?.id).toBeTruthy();

  const approveModeration = await page.request.put(
    `/api/admin/feedback/feedback/${approvedComment.id}/approve`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      failOnStatusCode: false,
    }
  );
  expect(approveModeration.ok()).toBeTruthy();

  // Submit a second comment that remains pending
  const pendingCommentResponse = await page.request.post(
    `/api/gallery/${createdEvent.slug}/photos/${photoIds[1]}/feedback`,
    {
      headers: {
        Authorization: `Bearer ${galleryToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        feedback_type: 'comment',
        comment_text: 'Pending comment',
        guest_name: 'Pending Guest',
        guest_email: 'pending@example.com',
      },
      failOnStatusCode: false,
    }
  );
  expect(pendingCommentResponse.ok()).toBeTruthy();

  const allPhotosResponse = await page.request.get(`/api/gallery/${createdEvent.slug}/photos`, {
    headers: {
      Authorization: `Bearer ${galleryToken}`,
    },
    failOnStatusCode: false,
  });
  expect(allPhotosResponse.ok()).toBeTruthy();
  const allPhotosData = await allPhotosResponse.json();
  expect(Array.isArray(allPhotosData?.photos)).toBeTruthy();

  return {
    shareLink: createdEvent.share_link,
    slug: createdEvent.slug,
    allPhotosData,
  };
}

test.describe('Gallery feedback filter', () => {
  test('Comment filter hides photos without approved comments', async ({ page }) => {
    const { shareLink, slug, allPhotosData } = await createGalleryWithModeratedComments(page);

    const approvedPhotos = allPhotosData.photos.filter((photo) => (photo.comment_count || 0) > 0);
    expect(approvedPhotos.length).toBeGreaterThan(0);

    await page.route(`**/api/gallery/${slug}/photos**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('filter') === 'commented') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(allPhotosData),
        });
        await page.unroute(`**/api/gallery/${slug}/photos**`);
      } else {
        await route.continue();
      }
    });

    await page.goto(shareLink);
    await page.waitForLoadState('domcontentloaded');

    const passwordField = page.getByPlaceholder(/gallery password/i).first();
    if (await passwordField.count()) {
      await passwordField.fill(GALLERY_PASSWORD);
      await page.getByRole('button', { name: /View Gallery/i }).click();
    }

    await page.waitForLoadState('networkidle');

    const tiles = page.locator('.relative.group');
    await expect(tiles.first()).toBeVisible({ timeout: 20000 });
    await expect(tiles).toHaveCount(allPhotosData.photos.length);

    await page.getByRole('button', { name: /Commented/i }).click();

    await expect(tiles).toHaveCount(approvedPhotos.length, { timeout: 20000 });

    for (const pending of allPhotosData.photos.filter((photo) => (photo.comment_count || 0) === 0)) {
      await expect(page.getByAltText(pending.filename)).not.toBeVisible({ timeout: 1000 });
    }
  });
});
