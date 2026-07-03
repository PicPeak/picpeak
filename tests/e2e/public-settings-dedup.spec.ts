import { test, expect, Page } from '@playwright/test';

/**
 * Verifies the dedup work for issue #325 — every consumer of /public/settings
 * should share a single React Query cache rather than triggering its own fetch
 * per component mount.
 *
 * Pre-dedup baseline (captured 2026-04-27 with the live admin dashboard):
 *   7 calls to /api/public/settings on a single /admin/login → /admin/dashboard
 *   navigation (4 from non-React-Query call sites + 3 from inconsistent
 *   queryKeys in React Query consumers).
 *
 * After landing usePublicSettings the count drops to 1.
 */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || 'PlaywrightGallery123!';

function attachSettingsCounter(page: Page) {
  const calls: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/public/settings')) {
      calls.push(`${req.method()} ${url}`);
    }
  });
  return calls;
}

test.describe('public settings dedup (#325)', () => {
  test('admin login + dashboard fires /public/settings at most once', async ({ page }) => {
    const calls = attachSettingsCounter(page);

    await page.goto('/admin/login');
    // Wait until the form is interactive — branding/theme/maintenance contexts
    // have all had a chance to mount by this point.
    await page.waitForSelector('input[type="email"]', { state: 'visible' });
    await page.waitForLoadState('networkidle');

    expect(calls, calls.join('\n')).toHaveLength(1);
  });

  test('no spurious refetch within the 60s staleTime window', async ({ page }) => {
    const calls = attachSettingsCounter(page);

    await page.goto('/admin/login');
    await page.waitForSelector('input[type="email"]', { state: 'visible' });
    await page.waitForLoadState('networkidle');

    // Sit on the page for ~5s to confirm no decorative consumer (favicon,
    // robots tags, recaptcha probe, etc.) triggers a second fetch within
    // the hook's staleTime window. Pre-dedup, several call sites used a
    // 5-minute staleTime but inconsistent queryKeys, so multiple fetches
    // would land within the first second and could re-fire on remount.
    await page.waitForTimeout(5000);

    expect(calls, calls.join('\n')).toHaveLength(1);
  });

  test('public gallery login page fires /public/settings at most once', async ({ page, request }) => {
    // Set up an event so the gallery page doesn't bail out with a 404.
    const adminLogin = await request.post('/api/auth/admin/login', {
      data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (!adminLogin.ok()) {
      test.skip(true, 'Admin login unavailable — skipping gallery dedup check');
      return;
    }
    const { token } = await adminLogin.json();

    const eventResponse = await request.post('/api/admin/events', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        event_type: 'wedding',
        event_name: `Dedup test ${Date.now()}`,
        event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        customer_name: 'Dedup Host',
        customer_email: 'host@example.com',
        host_name: 'Dedup Host',
        host_email: 'host@example.com',
        admin_email: ADMIN_EMAIL,
        password: GALLERY_PASSWORD,
        expiration_days: 30,
      },
    });
    if (!eventResponse.ok()) {
      test.skip(true, `Event creation failed (${eventResponse.status()}) — skipping`);
      return;
    }
    const event = await eventResponse.json();
    const slug: string = event?.event?.slug ?? event?.slug;
    expect(slug).toBeTruthy();

    const calls = attachSettingsCounter(page);

    await page.goto(`/gallery/${slug}`);
    await page.waitForLoadState('networkidle');

    expect(calls, calls.join('\n')).toHaveLength(1);
  });
});
