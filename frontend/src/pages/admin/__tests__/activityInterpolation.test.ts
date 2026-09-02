/**
 * Raw `{{placeholder}}` tokens leaking into the admin UI (QA bug #15b).
 *
 * Three confirmed sightings, two distinct call sites:
 *
 *  - Dashboard "recent activity" feed — `buildActivityParams` used to pass a
 *    fixed five-value allowlist (eventName / email / count / template /
 *    categoryName), so every `admin.activities.*` string interpolating
 *    anything else rendered its literal token: "Quote created: {{quoteNumber}}",
 *    "Webhook erstellt: {{name}}". The backend does record those values, they
 *    just never reached i18next.
 *
 *  - Notification bell — `bulk_archive_completed` fell through to the generic
 *    default branch, which spreads `metadata`. The bulk routes log
 *    `successfulCount`, never `count`, so the bell showed
 *    "Bulk archive completed: {{count}} events archived".
 *
 * These assertions are deliberately written against the *rendered output*: any
 * future regression that drops an interpolation value shows up as a surviving
 * "{{" in the string, whatever the mechanism.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../../i18n/config';
import { notificationsService, type Notification } from '../../../services/notifications.service';
import { buildActivityParams } from '../AdminDashboard';
import type { Activity } from '../../../services/admin.service';

const activity = (type: string, metadata: Record<string, unknown>): Activity =>
  ({
    id: 1,
    type,
    actorType: 'admin',
    actorName: 'admin',
    eventName: undefined,
    metadata,
    createdAt: '2026-09-01T12:00:00Z',
  }) as Activity;

const notification = (type: string, metadata: Record<string, unknown>): Notification =>
  ({
    id: 1,
    type,
    actorType: 'admin',
    actorName: 'admin',
    eventName: undefined,
    metadata,
    createdAt: '2026-09-01T12:00:00Z',
    isRead: false,
  }) as Notification;

const render = (a: Activity) =>
  i18n.t(`admin.activities.${a.type}`, buildActivityParams(a)) as string;

describe('dashboard activity feed interpolation', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('interpolates {{name}} for webhook_created', () => {
    const msg = render(activity('webhook_created', { name: 'n8n WhatsApp', events: ['event.published'] }));
    expect(msg).toContain('n8n WhatsApp');
    expect(msg).not.toContain('{{');
  });

  it('interpolates {{quoteNumber}} for quote_created', () => {
    const msg = render(activity('quote_created', { quoteId: 7, quoteNumber: 'Q-2026-0007' }));
    expect(msg).toContain('Q-2026-0007');
    expect(msg).not.toContain('{{');
  });

  it('still honours the derived overrides that are not plain metadata', () => {
    // `template` is read from metadata.template_key, `categoryName` from
    // metadata.category_name — the spread must not shadow those mappings.
    const params = buildActivityParams(
      activity('email_template_created', { template_key: 'gallery_created', category_name: 'Ceremony' })
    );
    expect(params.template).toBe('gallery_created');
    expect(params.categoryName).toBe('Ceremony');
  });

  it('leaves no raw placeholder on any German activity string either', async () => {
    await i18n.changeLanguage('de');
    const msg = render(activity('webhook_created', { name: 'ZZTEST-hook' }));
    expect(msg).toContain('ZZTEST-hook');
    expect(msg).not.toContain('{{');
    await i18n.changeLanguage('en');
  });
});

describe('notification bell interpolation', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('maps the bulk-archive metadata onto {{count}}', () => {
    // Exactly what adminEvents/archiveBulk.js writes — no `count` key.
    const msg = notificationsService.formatNotificationMessage(
      notification('bulk_archive_completed', { totalEvents: 5, successfulCount: 4, failedCount: 1 })
    );
    expect(msg).toContain('4');
    expect(msg).not.toContain('{{');
  });

  it('falls back to 0 rather than a placeholder when metadata is empty', () => {
    const msg = notificationsService.formatNotificationMessage(
      notification('bulk_archive_completed', {})
    );
    expect(msg).not.toContain('{{');
  });

  it('keeps interpolating the webhook/quote bell rows', () => {
    expect(
      notificationsService.formatNotificationMessage(notification('webhook_created', { name: 'n8n' }))
    ).not.toContain('{{');
    expect(
      notificationsService.formatNotificationMessage(
        notification('quote_created', { quoteNumber: 'Q-2026-0007' })
      )
    ).toContain('Q-2026-0007');
  });
});
