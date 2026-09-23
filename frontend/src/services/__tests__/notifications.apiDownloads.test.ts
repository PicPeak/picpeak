/**
 * v1 original downloads (issue 1473) log three activity types. Each must
 * render through a real locale key in the bell and the dashboard feed, in
 * English and German — otherwise the bell falls back to the generic
 * "system activity" line and the feed to the untranslated English map.
 */
import { describe, it, expect, afterAll } from 'vitest';
import i18n from '../../i18n/config';
import { notificationsService, type Notification } from '../notifications.service';
import { buildActivityParams } from '../../pages/admin/AdminDashboard';
import type { Activity } from '../admin.service';

const CASES: Array<[string, Record<string, unknown>, string[]]> = [
  ['api_photo_downloaded', { via: 'api_v1', token_id: 7, photo_id: 99 }, ['#7']],
  ['api_photos_downloaded', { via: 'api_v1', token_id: 7, token_name: 'n8n', count: 42, window_started_at: 0 }, ['n8n', '42']],
  ['api_photos_zip_downloaded', { via: 'api_v1', token_id: 7, token_name: 'n8n', photo_count: 12, missing_count: 0 }, ['n8n', '12']],
];

const notification = (type: string, metadata: Record<string, unknown>): Notification =>
  ({
    id: 1, type, actorType: 'admin', actorName: 'admin', eventName: 'Anna & Tom', eventId: 3,
    metadata, createdAt: '2026-09-22T12:00:00Z', readAt: null, isRead: false,
  }) as Notification;

const activity = (type: string, metadata: Record<string, unknown>): Activity =>
  ({
    id: 1, type, actorType: 'admin', actorName: 'admin', eventName: 'Anna & Tom',
    metadata, createdAt: '2026-09-22T12:00:00Z',
  }) as Activity;

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe.each(['en', 'de'])('API original download labels (%s)', (lng) => {
  it.each(CASES)('renders %s in the bell', async (type, metadata, expected) => {
    await i18n.changeLanguage(lng);
    const msg = notificationsService.formatNotificationMessage(notification(type, metadata));
    expect(msg).toContain('Anna & Tom');
    for (const part of expected) expect(msg).toContain(part);
    expect(msg).not.toContain('{{');
    expect(msg.toLowerCase()).not.toMatch(/system activity|systemaktivität/);
    expect(msg).not.toContain('notificationMessages');
  });

  it.each(CASES)('renders %s in the dashboard feed', async (type, metadata, expected) => {
    await i18n.changeLanguage(lng);
    const key = `admin.activities.${type}`;
    const msg = i18n.t(key, buildActivityParams(activity(type, metadata))) as string;
    expect(msg).not.toBe(key);
    expect(msg).toContain('Anna & Tom');
    for (const part of expected) expect(msg).toContain(part);
    expect(msg).not.toContain('{{');
  });
});

it('pluralises the summary count', async () => {
  await i18n.changeLanguage('en');
  const one = notificationsService.formatNotificationMessage(
    notification('api_photos_downloaded', { token_name: 'n8n', count: 1 }),
  );
  expect(one).toContain('1 original from');
  await i18n.changeLanguage('de');
  const many = notificationsService.formatNotificationMessage(
    notification('api_photos_downloaded', { token_name: 'n8n', count: 5 }),
  );
  expect(many).toContain('5 Originale');
});

it('styles the API download types with the download icon', () => {
  for (const [type] of CASES) {
    expect(notificationsService.getNotificationStyle(type).icon).toBe('Download');
  }
});
