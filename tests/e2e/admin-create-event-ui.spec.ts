import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

test('admin can create event via UI', async ({ page }) => {
  const eventName = `UI Playwright ${randomSuffix()}`;
  const hostEmail = `host+${randomSuffix()}@example.com`;

  // Login
  await page.goto('/admin/login');
  await page.getByLabel(/Email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/Password/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Sign In|Log in/i }).click();
  await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({ timeout: 20000 });

  // Navigate to create event page
  const createButton = page.getByRole('button', { name: /Create Event/i });
  if (await createButton.count()) {
    await createButton.first().click();
  } else {
    await page.goto('/admin/events/new');
  }

  await expect(page.getByRole('heading', { name: /^Create$/i })).toBeVisible({ timeout: 10000 });

  await page.getByLabel(/Event Name/i).fill(eventName);
  await page.getByLabel(/Customer Name/i).fill('Host User');
  await page.getByLabel(/Event Date/i).fill('2025-12-31');
  await page.getByLabel(/Customer Email/i).fill(hostEmail);
  await page.getByLabel(/Admin Email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/Gallery Password/i).fill('UiPlay123!');
  await page.getByLabel(/Confirm Password/i).fill('UiPlay123!');

  await page.getByRole('button', { name: /Create Event/i }).click();

  await expect(page).toHaveURL(/\/admin\/events\//, { timeout: 20000 });
  await expect(page.getByRole('heading', { name: eventName })).toBeVisible();
});
