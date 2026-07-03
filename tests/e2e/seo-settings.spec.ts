import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

// Helper to login and navigate to settings
async function loginAndGoToSeoSettings(page) {
  await page.goto('/admin/login');
  await page.getByLabel(/Email|E-Mail/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/Password|Passwort/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Sign In|Log in|Anmelden/i }).click();
  await expect(page.getByRole('heading', { name: /Dashboard|Übersicht/i })).toBeVisible({ timeout: 20000 });

  await page.goto('/admin/settings');
  // Click on SEO tab
  const seoTab = page.getByRole('button', { name: /SEO|Robots/i });
  await seoTab.click();
  await expect(page.getByRole('heading', { name: /Search Engine Indexing|Suchmaschinen-Indexierung/i })).toBeVisible({ timeout: 10000 });
}

test.describe('SEO Settings Tab', () => {
  test('SEO tab renders all sections correctly', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('SEO settings UI validated on desktop viewport');
    }

    await loginAndGoToSeoSettings(page);

    // Verify all three cards are visible
    await expect(page.getByRole('heading', { name: /Search Engine Indexing|Suchmaschinen-Indexierung/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /AI & Bot Blocking|KI- & Bot-Blockierung/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Meta Tags|Meta-Tags/i })).toBeVisible();

    // Verify key form elements
    await expect(page.getByLabel(/Allow search engine indexing|Suchmaschinen-Indexierung erlauben/i)).toBeVisible();
    await expect(page.getByLabel(/Block AI\/LLM crawlers|KI-\/LLM-Crawler blockieren/i)).toBeVisible();
    await expect(page.getByLabel(/Add noindex meta tag|noindex-Meta-Tag hinzufügen/i)).toBeVisible();
  });

  test('can toggle indexing and save settings', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('SEO settings UI validated on desktop viewport');
    }

    await loginAndGoToSeoSettings(page);

    const indexingToggle = page.getByLabel(/Allow search engine indexing|Suchmaschinen-Indexierung erlauben/i);
    const initialState = await indexingToggle.isChecked();

    // Toggle the setting
    await indexingToggle.click();

    // Save
    const saveButton = page.getByRole('button', { name: /Save SEO Settings|SEO-Einstellungen speichern/i });
    await saveButton.click();

    // Wait for success toast
    await expect(page.locator('.Toastify__toast--success')).toBeVisible({ timeout: 10000 });

    // Verify toggle state changed
    const newState = await indexingToggle.isChecked();
    expect(newState).toBe(!initialState);

    // Revert to original state
    await indexingToggle.click();
    await saveButton.click();
    await expect(page.locator('.Toastify__toast--success')).toBeVisible({ timeout: 10000 });
  });

  test('robots.txt preview updates based on settings', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('SEO settings UI validated on desktop viewport');
    }

    await loginAndGoToSeoSettings(page);

    // Click show preview button
    const previewButton = page.getByRole('button', { name: /Show robots\.txt preview|robots\.txt-Vorschau anzeigen/i });
    await previewButton.click();

    // Verify preview content is visible
    const previewContent = page.locator('pre');
    await expect(previewContent).toBeVisible();

    // Verify it contains expected content
    const previewText = await previewContent.textContent();
    expect(previewText).toContain('User-agent');
    expect(previewText).toContain('Disallow');
  });

  test('can add blocked AI agents', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip('SEO settings UI validated on desktop viewport');
    }

    await loginAndGoToSeoSettings(page);

    // Find the blocked agents section
    const agentInput = page.getByPlaceholder(/Enter agent name|Agentenname eingeben/i);
    await expect(agentInput).toBeVisible();

    // Add a new agent
    const testAgent = 'TestBot-' + Date.now();
    await agentInput.fill(testAgent);
    await agentInput.press('Enter');

    // Verify the agent tag appears in the list
    await expect(page.getByText(testAgent)).toBeVisible();

    // Save and verify it persists
    const saveButton = page.getByRole('button', { name: /Save SEO Settings|SEO-Einstellungen speichern/i });
    await saveButton.click();

    // Wait for success toast
    await expect(page.locator('.Toastify__toast--success')).toBeVisible({ timeout: 10000 });

    // Refresh and verify it's still there
    await page.reload();
    await page.getByRole('button', { name: /SEO|Robots/i }).click();
    await expect(page.getByText(testAgent)).toBeVisible({ timeout: 10000 });
  });
});

test.describe('robots.txt Endpoint', () => {
  test('returns valid robots.txt from backend', async ({ request }) => {
    const response = await request.get('/robots.txt');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/plain');

    const body = await response.text();
    expect(body).toContain('User-agent');
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /api');
  });

  test('robots.txt blocks AI crawlers by default', async ({ request }) => {
    const response = await request.get('/robots.txt');
    const body = await response.text();

    // Check for some of the default blocked AI agents
    expect(body).toContain('GPTBot');
    expect(body).toContain('Claude-Web');
    expect(body).toContain('Google-Extended');
  });
});

test.describe('SEO Meta Tags', () => {
  test('public settings include SEO meta flags', async ({ request }) => {
    const response = await request.get('/api/public/settings');
    expect(response.status()).toBe(200);

    const settings = await response.json();
    expect(settings).toHaveProperty('seo_meta_noindex');
    expect(settings).toHaveProperty('seo_meta_nofollow');
    expect(settings).toHaveProperty('seo_meta_noai');
  });
});
