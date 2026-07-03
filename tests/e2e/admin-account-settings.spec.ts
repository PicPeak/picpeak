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
  await page.getByRole('button', { name: /Sign In|Log in|Anmelden/i }).click();
  await expect(page.getByRole('heading', { name: /Dashboard|Übersicht/i })).toBeVisible({ timeout: 20000 });

  await page.goto('/admin/settings');
  const emailInput = page.getByLabel(/Admin (Email|E-Mail)/i);
  const usernameInput = page.getByLabel(/Admin (Username|Benutzername)/i);

  await expect(emailInput).toBeVisible();
  const originalEmail = await emailInput.inputValue();
  const originalUsername = await usernameInput.inputValue();

  const saveButton = page.getByRole('button', { name: /(Save account details|Kontodaten speichern)/i });

  const revertChanges = async () => {
    await emailInput.fill(originalEmail);
    await usernameInput.fill(originalUsername);
    await saveButton.click();
    await expect(emailInput).toHaveValue(originalEmail, { timeout: 10000 });
    await expect(page.locator('.Toastify__toast').filter({ hasText: /(Account details updated|Kontodaten aktualisiert)/i })).toBeVisible({ timeout: 10000 });
  };

  try {
    await emailInput.fill(newEmail);
    await saveButton.click();

    await expect(emailInput).toHaveValue(newEmail, { timeout: 10000 });
    await expect(page.locator('.Toastify__toast').filter({ hasText: /(Account details updated|Kontodaten aktualisiert)/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(newEmail, { exact: false })).toBeVisible();
  } finally {
    await revertChanges();
  }
});
