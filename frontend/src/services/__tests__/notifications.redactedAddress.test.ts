/**
 * Without customers.view the bell's and the dashboard feed's addresses
 * arrive as `…` (metadata and actor name). The message keeps its sentence
 * around the placeholder.
 */
import { expect, it } from 'vitest';
import i18n from '../../i18n/config';
import { notificationsService, type Notification } from '../notifications.service';
import { activityMessageKey, buildActivityParams } from '../../pages/admin/AdminDashboard';
import type { Activity } from '../admin.service';

it('renders a redacted customer address as … in the sentence', async () => {
  await i18n.changeLanguage('en');
  const message = notificationsService.formatNotificationMessage({
    id: 1, type: 'customer_login', actorType: 'customer', actorName: '…', eventName: null, eventId: null,
    metadata: { email: '…' }, createdAt: '2027-01-10T10:00:00Z', readAt: null, isRead: false,
  } as Notification);
  expect(message).toContain('…');
  expect(message).not.toMatch(/null|undefined|\{\{/);
});

it('renders a redacted customer address as … in the dashboard activity feed', async () => {
  await i18n.changeLanguage('en');
  const activity = {
    id: 1, type: 'customer_login', actorType: 'customer', actorName: '…', eventName: undefined,
    metadata: { email: '…' }, createdAt: '2027-01-10T10:00:00Z',
  } as Activity;
  const message = i18n.t(activityMessageKey(activity), buildActivityParams(activity)) as string;
  expect(message).toContain('…');
  expect(message).not.toMatch(/null|undefined|\{\{/);
});
