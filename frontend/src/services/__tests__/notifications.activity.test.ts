/**
 * Client-activity notification types (#746): gallery_opened /
 * gallery_downloaded (new logActivity calls in gallery.js) and
 * photo_favorite (logged by feedbackService since #400-era) must resolve
 * through the smart camelCase fallback in formatNotificationMessage —
 * i.e. the locale keys must exist, otherwise the bell renders the generic
 * "system activity" line.
 */
import { describe, it, expect } from 'vitest';
import i18n from '../../i18n/config';
import { notificationsService, type Notification } from '../notifications.service';

const base: Omit<Notification, 'type'> = {
  id: 1,
  actorType: 'guest',
  actorName: null,
  eventName: 'Anna & Tom',
  eventId: 42,
  metadata: {},
  createdAt: '2026-07-19T12:00:00Z',
  readAt: null,
  isRead: false,
} as any;

describe('client-activity notifications (#746)', () => {
  it.each(['gallery_opened', 'gallery_downloaded', 'photo_favorite'])(
    'formats %s via a real locale key (no generic fallback)',
    async (type) => {
      await i18n.changeLanguage('en');
      const msg = notificationsService.formatNotificationMessage({ ...base, type } as Notification);
      expect(msg).toContain('Anna & Tom');
      expect(msg.toLowerCase()).not.toContain('system activity');
    }
  );

  it('has a distinct style for each new type', () => {
    const opened = notificationsService.getNotificationStyle('gallery_opened');
    const downloaded = notificationsService.getNotificationStyle('gallery_downloaded');
    const favorite = notificationsService.getNotificationStyle('photo_favorite');
    expect(opened.icon).toBe('Eye');
    expect(downloaded.icon).toBe('Download');
    expect(favorite.icon).toBe('Heart');
  });
});
