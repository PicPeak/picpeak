import { test, expect } from '@playwright/test';
import { adminApiToken } from './_helpers/admin';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

test('admin can update account email via settings page', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile-chrome') {
    test.skip('Account settings UI is validated on desktop viewport');
  }

  const newEmail = `admin+playwright-${Date.now()}@example.com`;

  await page.goto('/admin/login');
  await page.getByLabel(/Email|E-Mail/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/Password|Passwort/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /^(Sign In|Log in|Anmelden)$/i }).click();
  await expect(page.getByRole('heading', { name: /Dashboard|Übersicht/i })).toBeVisible({ timeout: 20000 });

  // The settings page opens on the Features tab; the account card is on General.
  await page.goto('/admin/settings?tab=general');
  const emailInput = page.getByLabel(/Admin (Email|E-Mail)/i);

  await expect(emailInput).toBeVisible();

  // The account as it is now, restored through the API at the end: every
  // later spec signs in with ADMIN_EMAIL, so a changed email left behind
  // fails them all. Token and profile are read before anything changes.
  const token = await adminApiToken(page.request);
  const headers = { Authorization: `Bearer ${token}` };
  const profileResponse = await page.request.get('/api/admin/auth/profile', { headers });
  expect(profileResponse.ok(), await profileResponse.text()).toBeTruthy();
  const original = await profileResponse.json();

  // Settings save through the bar pinned to the window bottom, which shows
  // with "You have unsaved changes" until they are saved.
  const saveBar = page.getByRole('region', { name: /Save or discard changes|Änderungen speichern oder verwerfen/i });
  const save = async () => {
    await saveBar.getByRole('button', { name: /Save changes|Änderungen speichern/i }).click();
    await expect(saveBar.getByText(/unsaved changes|ungespeicherte Änderungen/i)).toBeHidden({ timeout: 10000 });
  };

  try {
    await emailInput.fill(newEmail);
    await save();

    await page.reload();
    await expect(emailInput).toHaveValue(newEmail, { timeout: 10000 });
  } finally {
    const restore = await page.request.put('/api/admin/auth/profile', {
      headers,
      data: { username: original.username, email: original.email, credit_name: original.creditName ?? null },
    });
    expect(restore.ok(), await restore.text()).toBeTruthy();
  }
});
