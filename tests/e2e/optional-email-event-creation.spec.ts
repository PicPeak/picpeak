import { test, expect, Page } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin!234';

async function getAdminToken(page: Page): Promise<string> {
  const res = await page.request.post('/api/auth/admin/login', {
    data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.token).toBeTruthy();
  return body.token;
}

async function updateEventSettings(
  page: Page,
  token: string,
  settings: Record<string, boolean>
) {
  const res = await page.request.put('/api/admin/settings/general', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: settings,
  });
  expect(res.ok()).toBeTruthy();
}

test.describe('Optional email fields in event creation (#217)', () => {
  test('event creation succeeds with empty emails when set to optional', async ({ page }) => {
    const token = await getAdminToken(page);

    // Disable email requirements
    await updateEventSettings(page, token, {
      event_require_customer_email: false,
      event_require_admin_email: false,
    });

    try {
      // Create event with empty email fields
      const eventRes = await page.request.post('/api/admin/events', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          event_type: 'wedding',
          event_name: `E2E Optional Emails ${Date.now()}`,
          event_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          customer_name: 'Test Host',
          customer_email: '',
          admin_email: '',
          password: 'TestPass123!',
          expiration_days: 30,
        },
      });

      const body = await eventRes.json();
      expect(eventRes.ok(), `Expected 200 but got ${eventRes.status()}: ${JSON.stringify(body)}`).toBeTruthy();
      expect(body.id).toBeTruthy();

      // Cleanup: delete the created event
      await page.request.delete(`/api/admin/events/${body.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } finally {
      // Revert settings to required
      await updateEventSettings(page, token, {
        event_require_customer_email: true,
        event_require_admin_email: true,
      });
    }
  });

  test('event creation still fails with empty emails when set to required', async ({ page }) => {
    const token = await getAdminToken(page);

    // Ensure email requirements are enabled
    await updateEventSettings(page, token, {
      event_require_customer_email: true,
      event_require_admin_email: true,
    });

    const eventRes = await page.request.post('/api/admin/events', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        event_type: 'wedding',
        event_name: `E2E Required Emails ${Date.now()}`,
        event_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        customer_name: 'Test Host',
        customer_email: '',
        admin_email: '',
        password: 'TestPass123!',
        expiration_days: 30,
      },
    });

    expect(eventRes.status()).toBe(400);
    const body = await eventRes.json();
    const paths = body.errors.map((e: { path: string }) => e.path);
    expect(paths).toContain('customer_email');
    expect(paths).toContain('admin_email');
  });

  test('event creation succeeds with missing email fields when optional', async ({ page }) => {
    const token = await getAdminToken(page);

    // Disable email requirements
    await updateEventSettings(page, token, {
      event_require_customer_email: false,
      event_require_admin_email: false,
    });

    try {
      // Create event without email fields at all (undefined, not empty string)
      const eventRes = await page.request.post('/api/admin/events', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          event_type: 'wedding',
          event_name: `E2E Missing Emails ${Date.now()}`,
          event_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          customer_name: 'Test Host',
          password: 'TestPass123!',
          expiration_days: 30,
        },
      });

      const body = await eventRes.json();
      expect(eventRes.ok(), `Expected 200 but got ${eventRes.status()}: ${JSON.stringify(body)}`).toBeTruthy();
      expect(body.id).toBeTruthy();

      // Cleanup
      await page.request.delete(`/api/admin/events/${body.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } finally {
      await updateEventSettings(page, token, {
        event_require_customer_email: true,
        event_require_admin_email: true,
      });
    }
  });
});
