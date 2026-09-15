import { test, expect } from '@playwright/test';
import { adminApiToken } from './_helpers/admin';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';

test('clearing notifications removes read entries @smoke', async ({ request }) => {
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

  const collectedNotifications = async () => {
    const notificationsResponse = await request.get('/api/admin/notifications', {
      headers: authHeaders,
      params: { includeRead: true, limit: 200 },
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

  // clear-old was replaced by clear-all (see backend/src/routes/adminNotifications.js).
  const clearResponse = await request.delete('/api/admin/notifications/clear-all', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(clearResponse.ok()).toBeTruthy();
  const clearPayload = await clearResponse.json();
  expect(clearPayload.deletedCount).toBeGreaterThanOrEqual(0);

  const afterClearPayload = await collectedNotifications();
  expect(Array.isArray(afterClearPayload.notifications)).toBe(true);
  const remainingIds = new Set(afterClearPayload.notifications.map((notification: any) => notification.id));
  readNotificationIds.forEach((id) => {
    expect(remainingIds.has(id)).toBe(false);
  });
});
