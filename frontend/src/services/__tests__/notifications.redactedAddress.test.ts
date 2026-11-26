/**
 * Without customers.view the bell's addresses arrive as `…` (metadata and
 * actor name). The message keeps its sentence around the placeholder.
 */
import { expect, it } from 'vitest';
import i18n from '../../i18n/config';
import { notificationsService, type Notification } from '../notifications.service';

it('renders a redacted customer address as … in the sentence', async () => {
  await i18n.changeLanguage('en');
  const message = notificationsService.formatNotificationMessage({
    id: 1, type: 'customer_login', actorType: 'customer', actorName: '…', eventName: null, eventId: null,
    metadata: { email: '…' }, createdAt: '2027-01-10T10:00:00Z', readAt: null, isRead: false,
  } as Notification);
  expect(message).toContain('…');
  expect(message).not.toMatch(/null|undefined|\{\{/);
});
