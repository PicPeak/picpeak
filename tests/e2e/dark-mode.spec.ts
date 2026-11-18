import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

// Helper to login to admin
async function loginToAdmin(page) {
  await page.goto('/admin/login');
  await page.getByLabel(/Email|E-Mail/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/Password|Passwort/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /^(Sign In|Log in|Anmelden)$/i }).click();
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
    // The layout's background is the bg-canvas token, dark in dark mode.
    const mainContainer = page.locator('.h-screen.bg-canvas').first();
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
    // The page opens on its first section (Features); its heading is the
    // page's only level-1 heading.
    const heading = page.locator('main').getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Verify the heading has light text in dark mode
    const headingColor = await heading.evaluate(el => getComputedStyle(el).color);

    // In dark mode, text should be light (not dark)
    // neutral-100 is approximately rgb(245, 245, 245)
    const [r, g, b] = headingColor.match(/\d+/g).map(Number);
    expect(r + g + b).toBeGreaterThan(500); // Light colored text

    // The sections are links in the settings navigation.
    const sections = page.getByRole('navigation', { name: /^(Settings|Einstellungen)$/ });
    await expect(sections.getByRole('link', { name: /^(General|Allgemein)$/ })).toBeVisible();
    await expect(sections.getByRole('link', { name: /^SEO/ })).toBeVisible();
    await expect(sections.getByRole('link', { name: /^(Security|Sicherheit)$/ })).toBeVisible();

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
    // Anchored: "Force color mode" on the same page matches an unanchored regex.
    await expect(page.getByText(/^(Color Mode|Farbmodus)$/i)).toBeVisible();

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

    // Force color mode is a draft like every branding setting: pick it, then
    // save through the bar pinned to the window bottom. It reports unsaved
    // changes only when the pick differs from what is saved.
    const saveForceMode = async (name: RegExp) => {
      await page.goto('/admin/branding');
      await page.getByRole('button', { name }).click();
      const saveBar = page.getByRole('region', { name: /Save or discard changes|Änderungen speichern oder verwerfen/i });
      if (!(await saveBar.getByText(/unsaved changes|ungespeicherte Änderungen/i).waitFor({ timeout: 3000 }).then(() => true, () => false))) return;
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/admin/settings/branding') && r.request().method() === 'PUT' && r.ok()),
        saveBar.getByRole('button', { name: /Save changes|Änderungen speichern/i }).click(),
      ]);
      await expect(saveBar.getByText(/unsaved changes|ungespeicherte Änderungen/i)).toBeHidden({ timeout: 10000 });
    };

    try {
      // Inside the try: a save that lands but fails a later check still
      // gets the restore below.
      await saveForceMode(/Force dark|Dunkel erzwingen/i);

      // Load a fresh page so the public-settings fetch picks up the new value.
      // The dashboard, not a reload of Branding: that page has color mode
      // buttons of its own that the toggle locator below would also match.
      await page.goto('/admin/dashboard');
      await expect(page.getByRole('heading', { name: /Dashboard|Übersicht/i })).toBeVisible({ timeout: 20000 });

      toggle = page.getByRole('button', { name: /dark mode|light mode|Dunkelmodus|Hellmodus/i });
      await expect(toggle).toHaveCount(0);

      // The .dark class should be applied to <html>.
      const html = page.locator('html');
      await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    } finally {
      // Restore even when an assertion above failed: a forced dark theme left
      // behind fails every later spec that expects the light default. Through
      // the page, not the API, because PUT /branding writes every branding key
      // and the page sends them all back.
      await saveForceMode(/^(No force|Kein Zwang)/i);
    }
  });
});
