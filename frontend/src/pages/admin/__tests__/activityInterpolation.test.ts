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

describe('newsletter activity strings (#1264)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  // The exact metadata newsletterService writes for each type. Anything that
  // drifts between the log call and the i18n string surfaces as a raw
  // `{{token}}` in the dashboard feed and the bell.
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['newsletter_created',   { campaignId: 1, name: 'Spring' }],
    ['newsletter_updated',   { campaignId: 1, fields: ['subject'] }],
    ['newsletter_test_sent', { campaignId: 1, to: 'you@example.com' }],
    ['newsletter_queued',    { campaignId: 1, name: 'Spring', recipients: 42, skippedOptOut: 3, sendRatePerMinute: 10 }],
    ['newsletter_cancelled', { campaignId: 1, name: 'Spring', cancelledRows: 12 }],
    ['newsletter_completed', { campaignId: 1, name: 'Spring', sent: 40, failed: 2 }],
    ['newsletter_deleted',   { campaignId: 1, name: 'Spring' }],
    ['customer_marketing_opt_out', { customerId: 7, optOut: true, source: 'link' }],
  ];

  it.each(CASES)('renders %s without a raw placeholder', (type, metadata) => {
    const msg = render(activity(type, metadata));
    expect(msg).not.toContain('{{');
    // A missing key would render the key path itself.
    expect(msg).not.toContain('admin.activities.');
  });

  it('interpolates the recipient count into newsletter_queued', () => {
    const msg = render(activity('newsletter_queued', { name: 'Spring', recipients: 42 }));
    expect(msg).toContain('42');
  });

  it('interpolates both counts into newsletter_completed', () => {
    const msg = render(activity('newsletter_completed', { name: 'Spring', sent: 40, failed: 2 }));
    expect(msg).toContain('40');
    expect(msg).toContain('2');
  });

  it('renders every newsletter string in German too', async () => {
    await i18n.changeLanguage('de');
    for (const [type, metadata] of CASES) {
      const msg = render(activity(type, metadata));
      expect(msg).not.toContain('{{');
      expect(msg).not.toContain('admin.activities.');
    }
    await i18n.changeLanguage('en');
  });

  it('renders in the notification bell as well as the dashboard feed', () => {
    for (const [type, metadata] of CASES) {
      const msg = notificationsService.formatNotificationMessage(notification(type, metadata));
      expect(msg).not.toContain('{{');
    }
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
