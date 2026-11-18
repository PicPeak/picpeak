import { test, expect } from '@playwright/test';

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
  const usernameInput = page.getByLabel(/Admin (Username|Benutzername)/i);

  await expect(emailInput).toBeVisible();
  const originalEmail = await emailInput.inputValue();
  const originalUsername = await usernameInput.inputValue();

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
    await emailInput.fill(originalEmail);
    await usernameInput.fill(originalUsername);
    // Unsaved changes only when the fields differ from what is saved.
    if (await saveBar.getByText(/unsaved changes|ungespeicherte Änderungen/i).waitFor({ timeout: 3000 }).then(() => true, () => false)) await save();
  }
});
