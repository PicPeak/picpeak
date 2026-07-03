import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

// Helper to login to admin
async function loginToAdmin(page) {
  await page.goto('/admin/login');
  await page.getByLabel(/Email|E-Mail/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/Password|Passwort/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Sign In|Log in|Anmelden/i }).click();
  await expect(page.getByRole('heading', { name: /Dashboard|Übersicht/i })).toBeVisible({ timeout: 20000 });
}

test.describe('Admin Dark Mode Toggle', () => {
  test('dark mode toggle button exists in admin header', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Dark mode toggle validated on desktop viewport');
    }

    await loginToAdmin(page);

    // Look for the dark mode toggle button
    const toggleButton = page.getByRole('button', { name: /dark mode|light mode|Dunkelmodus|Hellmodus/i });
    await expect(toggleButton).toBeVisible();
  });

  test('clicking toggle switches to dark mode and adds dark class', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Dark mode toggle validated on desktop viewport');
    }

    await loginToAdmin(page);

    // Check initial state - should be light
    const html = page.locator('html');
    const initialHasDark = await html.evaluate(el => el.classList.contains('dark'));

    // Click the toggle
    const toggleButton = page.getByRole('button', { name: /dark mode|light mode|Dunkelmodus|Hellmodus/i });
    await toggleButton.click();

    // Wait a moment for the class to toggle
    await page.waitForTimeout(500);

    // Verify dark class toggled
    const afterHasDark = await html.evaluate(el => el.classList.contains('dark'));
    expect(afterHasDark).toBe(!initialHasDark);

    // Click again to revert
    await toggleButton.click();
    await page.waitForTimeout(500);

    const finalHasDark = await html.evaluate(el => el.classList.contains('dark'));
    expect(finalHasDark).toBe(initialHasDark);
  });

  test('dark mode preference persists across page reloads', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Dark mode toggle validated on desktop viewport');
    }

    await loginToAdmin(page);

    // Set to dark mode
    const html = page.locator('html');
    const isAlreadyDark = await html.evaluate(el => el.classList.contains('dark'));

    if (!isAlreadyDark) {
      const toggleButton = page.getByRole('button', { name: /dark mode|Dunkelmodus/i });
      await toggleButton.click();
      await page.waitForTimeout(500);
    }

    // Verify dark mode is active
    await expect(html).toHaveAttribute('class', /dark/);

    // Reload the page
    await page.reload();
    await expect(page.getByRole('heading', { name: /Dashboard|Übersicht/i })).toBeVisible({ timeout: 20000 });

    // Verify dark mode persists
    await expect(html).toHaveAttribute('class', /dark/);

    // Clean up - switch back to light mode
    const toggleButton = page.getByRole('button', { name: /light mode|Hellmodus/i });
    await toggleButton.click();
    await page.waitForTimeout(500);
  });

  test('dark mode applies correct dark background to admin layout', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Dark mode toggle validated on desktop viewport');
    }

    await loginToAdmin(page);

    // Enable dark mode
    const html = page.locator('html');
    const isAlreadyDark = await html.evaluate(el => el.classList.contains('dark'));

    if (!isAlreadyDark) {
      const toggleButton = page.getByRole('button', { name: /dark mode|Dunkelmodus/i });
      await toggleButton.click();
      await page.waitForTimeout(500);
    }

    // Verify the main layout container has dark background
    const mainContainer = page.locator('.h-screen.bg-neutral-50, .h-screen.dark\\:bg-neutral-950').first();
    const bgColor = await mainContainer.evaluate(el => getComputedStyle(el).backgroundColor);

    // In dark mode, background should be very dark (close to black)
    // neutral-950 is approximately rgb(10, 10, 10)
    expect(bgColor).not.toBe('rgb(255, 255, 255)'); // Not white
    expect(bgColor).not.toBe('rgba(0, 0, 0, 0)'); // Not transparent

    // Clean up
    const toggleButton = page.getByRole('button', { name: /light mode|Hellmodus/i });
    await toggleButton.click();
    await page.waitForTimeout(500);
  });

  test('dark mode preference is stored in localStorage', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Dark mode toggle validated on desktop viewport');
    }

    await loginToAdmin(page);

    // Enable dark mode
    const html = page.locator('html');
    const isAlreadyDark = await html.evaluate(el => el.classList.contains('dark'));

    if (!isAlreadyDark) {
      const toggleButton = page.getByRole('button', { name: /dark mode|Dunkelmodus/i });
      await toggleButton.click();
      await page.waitForTimeout(500);
    }

    // Verify dark mode preference is stored in localStorage
    const storedPreference = await page.evaluate(() => localStorage.getItem('admin-dark-mode'));
    expect(storedPreference).toBe('dark');

    // Clean up - toggle back to light
    const toggleButton = page.getByRole('button', { name: /light mode|Hellmodus/i });
    await toggleButton.click();
    await page.waitForTimeout(500);

    // Verify light mode preference is stored
    const lightPreference = await page.evaluate(() => localStorage.getItem('admin-dark-mode'));
    expect(lightPreference).toBe('light');
  });
});

test.describe('Settings Page Dark Mode', () => {
  test('settings page tabs render correctly in dark mode', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Settings dark mode validated on desktop viewport');
    }

    await loginToAdmin(page);

    // Enable dark mode
    const html = page.locator('html');
    const isAlreadyDark = await html.evaluate(el => el.classList.contains('dark'));

    if (!isAlreadyDark) {
      const toggleButton = page.getByRole('button', { name: /dark mode|Dunkelmodus/i });
      await toggleButton.click();
      await page.waitForTimeout(500);
    }

    // Go to settings
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { name: /Settings|Einstellungen/i })).toBeVisible({ timeout: 10000 });

    // Verify settings heading has dark text style
    const heading = page.getByRole('heading', { name: /Settings|Einstellungen/i }).first();
    const headingColor = await heading.evaluate(el => getComputedStyle(el).color);

    // In dark mode, text should be light (not dark)
    // neutral-100 is approximately rgb(245, 245, 245)
    const [r, g, b] = headingColor.match(/\d+/g).map(Number);
    expect(r + g + b).toBeGreaterThan(500); // Light colored text

    // Verify tab buttons are visible (use exact: true to avoid matching save buttons)
    await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^SEO & Robots$|^SEO$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Security', exact: true })).toBeVisible();

    // Clean up
    const toggleButton = page.getByRole('button', { name: /light mode|Hellmodus/i });
    await toggleButton.click();
    await page.waitForTimeout(500);
  });
});

test.describe('Gallery Theme Color Mode', () => {
  test('branding page has color mode selector', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Theme customizer validated on desktop viewport');
    }

    await loginToAdmin(page);

    await page.goto('/admin/branding');
    await expect(page.getByText(/Theme|Themen/i).first()).toBeVisible({ timeout: 10000 });

    // Look for the color mode selector
    await expect(page.getByText(/Color Mode|Farbmodus/i)).toBeVisible();

    // Verify the mode buttons exist
    await expect(page.getByRole('button', { name: /^Light$|^Hell$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Dark$|^Dunkel$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Auto$/i })).toBeVisible();
  });
});

test.describe('Force color mode (instance-wide lock)', () => {
  // The force color mode setting is exposed in Branding > Force color mode.
  // When set, the user-facing dark/light toggle in the admin header should
  // disappear entirely. We verify both presence of the controls and that
  // toggling them hides the header chip.
  test('force-mode controls are present in Branding settings', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Force color mode validated on desktop viewport');
    }

    await loginToAdmin(page);

    await page.goto('/admin/branding');
    await expect(page.getByRole('heading', { name: /Force color mode|Farbmodus erzwingen/i })).toBeVisible({ timeout: 10000 });

    // The three states must be selectable as buttons.
    await expect(page.getByRole('button', { name: /No force|Kein/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Force dark|Dunkel erzwingen/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Force light|Hell erzwingen/i })).toBeVisible();
  });

  test('selecting force-dark hides the header dark mode toggle on next reload', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('Force color mode validated on desktop viewport');
    }

    await loginToAdmin(page);

    // Confirm the toggle is initially visible (no force mode set).
    let toggle = page.getByRole('button', { name: /dark mode|light mode|Dunkelmodus|Hellmodus/i });
    await expect(toggle).toBeVisible();

    // Set force-dark via Branding page.
    await page.goto('/admin/branding');
    await page.getByRole('button', { name: /Force dark|Dunkel erzwingen/i }).click();
    await page.getByRole('button', { name: /^Save|^Speichern/i }).first().click();

    // Reload so the public-settings refetch picks up the new value.
    await page.reload();
    await page.waitForLoadState('networkidle');

    toggle = page.getByRole('button', { name: /dark mode|light mode|Dunkelmodus|Hellmodus/i });
    await expect(toggle).toHaveCount(0);

    // The .dark class should be applied to <html>.
    const html = page.locator('html');
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);

    // Restore: clear the force mode so subsequent test runs aren't affected.
    await page.goto('/admin/branding');
    await page.getByRole('button', { name: /No force|Kein/i }).click();
    await page.getByRole('button', { name: /^Save|^Speichern/i }).first().click();
  });
});
