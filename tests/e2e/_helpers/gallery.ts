import { expect, type Page } from '@playwright/test';

/**
 * After opening a share link, get past the password prompt if the gallery
 * shows one. Waits for the prompt or the opened gallery first: checking for
 * the password field right after `goto` runs before the SPA has rendered
 * either, finds nothing and leaves the test on the prompt.
 */
export async function passGalleryPasswordPrompt(page: Page, password: string): Promise<void> {
  const prompt = page.getByRole('heading', { name: /Enter Gallery Password|Galerie-Passwort/i });
  // The header is on every viewport; the Logout button moves into a menu on
  // phones, so it can't be the signal.
  const opened = page.locator('header.gallery-header');
  await expect(prompt.or(opened).first()).toBeVisible({ timeout: 20_000 });
  if (await prompt.isVisible()) {
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole('button', { name: /View Gallery|Galerie ansehen/i }).click();
    await expect(prompt).toBeHidden({ timeout: 20_000 });
  }
}
