import { test, expect, Page } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

async function getAdminToken(page: Page): Promise<string> {
  const res = await page.request.post('/api/auth/admin/login', {
    data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok()).toBeTruthy();
  const { token } = await res.json();
  return token;
}

test.describe('Photo Dimensions Repair (#180)', () => {
  test('Status endpoint returns dimension counts', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip();
    }

    const token = await getAdminToken(page);

    const statusRes = await page.request.get('/api/admin/photos/repair-dimensions/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(statusRes.ok()).toBeTruthy();

    const status = await statusRes.json();
    expect(status).toHaveProperty('total');
    expect(status).toHaveProperty('withDimensions');
    expect(status).toHaveProperty('withoutDimensions');
    expect(status).toHaveProperty('isRunning');
    expect(typeof status.total).toBe('number');
    expect(typeof status.isRunning).toBe('boolean');
  });

  test('Repair endpoint runs and returns immediately', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'mobile-chrome') {
      test.skip();
    }

    const token = await getAdminToken(page);

    const repairRes = await page.request.post('/api/admin/photos/repair-dimensions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(repairRes.ok()).toBeTruthy();

    const body = await repairRes.json();
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('count');

    // Wait for background job to complete
    await page.waitForTimeout(3000);

    // Check status after repair
    const statusRes = await page.request.get('/api/admin/photos/repair-dimensions/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(statusRes.ok()).toBeTruthy();
    const status = await statusRes.json();
    expect(status.isRunning).toBe(false);
  });
});
