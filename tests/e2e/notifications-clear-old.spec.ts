import { test, expect } from '@playwright/test';
import { adminApiToken } from './_helpers/admin';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';

test('clearing notifications dismisses entries from the bell without deleting the audit log @smoke', async ({ request }) => {
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

  // Clear all marks the caller's visible rows read; activity_logs is also the
  // audit trail (contract history, customer timelines), so nothing is deleted
  // (see backend/src/routes/adminNotifications.js).
  const clearResponse = await request.delete('/api/admin/notifications/clear-all', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(clearResponse.ok()).toBeTruthy();
  const clearPayload = await clearResponse.json();
  expect(clearPayload.deletedCount).toBeGreaterThanOrEqual(0);

  // Gone from the bell's default (unread) view ...
  const unreadAfterClear = await collectedNotifications(false);
  expect(Array.isArray(unreadAfterClear.notifications)).toBe(true);
  const unreadIds = new Set(unreadAfterClear.notifications.map((notification: any) => notification.id));
  readNotificationIds.forEach((id) => {
    expect(unreadIds.has(id)).toBe(false);
  });

  // ... but the audit rows themselves survive, marked read.
  const allAfterClear = await collectedNotifications(true);
  const survivingById = new Map(allAfterClear.notifications.map((notification: any) => [notification.id, notification]));
  readNotificationIds.forEach((id) => {
    expect(survivingById.has(id)).toBe(true);
    expect(survivingById.get(id).isRead).toBe(true);
  });
});
