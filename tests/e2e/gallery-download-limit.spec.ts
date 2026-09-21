import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { adminApiToken, publishEvent, waitForPhotosProcessed } from './_helpers/admin';
import { passGalleryPasswordPrompt } from './_helpers/gallery';

// Download limit (issue 1560): a gallery sold with N included photos. With a
// limit of 1 and two photos: selecting both is flagged before the click, the
// first photo downloads, the second is refused with the limit message, and
// the first stays downloadable because it was already counted.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';

async function createLimitedGallery(page: Page) {
  const token = await adminApiToken(page.request);
  const createResponse = await page.request.post('/api/admin/events', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      event_type: 'wedding',
      event_name: `Download limit ${Date.now()}`,
      event_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      customer_name: 'Playwright Host',
      customer_email: 'host@example.com',
      admin_email: ADMIN_EMAIL,
      password: GALLERY_PASSWORD,
      expiration_days: 90,
      allow_downloads: true,
      download_limit: 1,
    },
    failOnStatusCode: false,
  });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
  const event = await createResponse.json();
  await publishEvent(page.request, token, event.id);

  for (const file of ['img1.png', 'img2.png']) {
    const upload = await page.request.post(`/api/admin/events/${event.id}/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        photos: { name: file, mimeType: 'image/png', buffer: fs.readFileSync(path.join(process.cwd(), 'test-assets', file)) },
        category_id: 'individual',
      },
      failOnStatusCode: false,
    });
    expect(upload.ok(), await upload.text()).toBeTruthy();
  }
  await waitForPhotosProcessed(page.request, token, event.id);
  return event as { id: number; slug: string; share_link: string };
}

test.describe('Gallery download limit (issue 1560)', () => {
  test('flags an oversized selection, grants one photo and refuses the next', async ({ page }) => {
    const event = await createLimitedGallery(page);

    await page.goto(event.share_link);
    await passGalleryPasswordPrompt(page, GALLERY_PASSWORD);

    const counter = page.getByTestId('download-quota-counter').first();
    await expect(counter).toContainText('0 of 1 downloads used');

    const tiles = page.locator('.relative.group');
    await expect(tiles).toHaveCount(2, { timeout: 20_000 });

    // Both photos selected with one download left: flagged before the click.
    await page.getByRole('button', { name: /^Select All$/i }).first().click();
    await expect(page.getByTestId('download-quota-selection').first())
      .toContainText('this selection needs 2 downloads, only 1 left');
    await page.getByRole('button', { name: /^Cancel Selection$/i }).first().click();

    // The first photo downloads and uses the quota up.
    const first = tiles.nth(0);
    await first.hover({ force: true });
    const download = page.waitForEvent('download');
    await first.getByRole('button', { name: /Download photo/i }).click();
    await download;
    await expect(counter).toContainText('1 of 1 downloads used');

    // The second is shown as unavailable; clicking it anyway explains the
    // refusal and delivers no file.
    const second = tiles.nth(1);
    await second.hover({ force: true });
    const secondButton = second.getByRole('button', { name: /Download photo/i });
    await expect(secondButton).toHaveAttribute('aria-disabled', 'true');
    let refusedDownload = false;
    const onDownload = () => { refusedDownload = true; };
    page.on('download', onDownload);
    await secondButton.click({ force: true });
    await expect(page.getByText(/Download limit reached/i).first()).toBeVisible();
    page.off('download', onDownload);
    expect(refusedDownload).toBe(false);

    // The first photo was already counted, so it downloads again for free.
    await first.hover({ force: true });
    const again = page.waitForEvent('download');
    await first.getByRole('button', { name: /Download photo/i }).click();
    await again;
  });
});
