import { test, expect, Page } from '@playwright/test';
import { adminApiToken } from './_helpers/admin';

async function getAdminToken(page: Page): Promise<string> {
  return adminApiToken(page.request);
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
