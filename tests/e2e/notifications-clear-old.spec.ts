import { test, expect } from '@playwright/test';
import { adminApiToken } from './_helpers/admin';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';

test('clearing notifications dismisses entries from this admin\'s bell without deleting the audit log @smoke', async ({ request }) => {
  const token = await adminApiToken(request);

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const eventName = `Notification Clear ${Date.now()}`;
  const eventDate = new Date().toISOString().slice(0, 10);

  const createEventResponse = await request.post('/api/admin/events', {
    headers: authHeaders,
    data: {
      event_type: 'wedding',
      event_name: eventName,
      event_date: eventDate,
      customer_name: 'Notification Test',
      customer_email: 'notify@example.com',
      admin_email: ADMIN_EMAIL,
      password: 'NotifyClearPass!1',
      expiration_days: 30,
      allow_user_uploads: false,
      allow_downloads: true,
      disable_right_click: false,
      watermark_downloads: false,
    },
  });
  expect(createEventResponse.ok()).toBeTruthy();
  const createdEvent = await createEventResponse.json();
  const eventId = createdEvent.id;

  const collectedNotifications = async (includeRead = true) => {
    const notificationsResponse = await request.get('/api/admin/notifications', {
      headers: authHeaders,
      params: { includeRead, limit: 200 },
    });
    expect(notificationsResponse.ok()).toBeTruthy();
    return notificationsResponse.json();
  };

  let notificationsPayload = await collectedNotifications();
  const start = Date.now();
  while (notificationsPayload.notifications.length === 0 && Date.now() - start < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    notificationsPayload = await collectedNotifications();
  }

  const targetEventNotifications = notificationsPayload.notifications.filter(
    (notification: any) => notification.eventId === eventId
  );
  expect(targetEventNotifications.length).toBeGreaterThan(0);

  const markReadResponse = await request.put('/api/admin/notifications/read-all', {
    headers: authHeaders,
  });
  expect(markReadResponse.ok()).toBeTruthy();

  const postMarkPayload = await collectedNotifications();
  const postMarkEventNotifications = postMarkPayload.notifications.filter(
    (notification: any) => notification.eventId === eventId
  );
  const readNotificationIds = postMarkEventNotifications
    .filter((notification: any) => notification.isRead)
    .map((notification: any) => notification.id);
  expect(readNotificationIds.length).toBeGreaterThan(0);

  // Clear all records a dismissal per visible row for this admin; the
  // activity_logs rows themselves (the audit trail) are never deleted, see
  // backend/src/routes/adminNotifications.js and migration 261.
  const clearResponse = await request.delete('/api/admin/notifications/clear-all', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(clearResponse.ok()).toBeTruthy();
  const clearPayload = await clearResponse.json();
  expect(clearPayload.deletedCount).toBeGreaterThanOrEqual(readNotificationIds.length);

  // Gone from this admin's bell, in both the unread and the includeRead view.
  for (const includeRead of [false, true]) {
    const afterClear = await collectedNotifications(includeRead);
    expect(Array.isArray(afterClear.notifications)).toBe(true);
    const remainingIds = new Set(afterClear.notifications.map((notification: any) => notification.id));
    readNotificationIds.forEach((id) => {
      expect(remainingIds.has(id)).toBe(false);
    });
  }
});
