/**
 * The "complete gallery" dialog lists exactly whom the server mails
 * (galleryNotificationService.notifyGalleryCompleted): no account for a
 * draft, archived or expired gallery, and one person in both fields gets the
 * portal version even when the gallery has a welcome message.
 */
import { describe, it, expect } from 'vitest';
import { accountsAnnounceable, eventNotice, type AccountReach } from '../OverviewTab';
import type { Event } from '../../../../types';

const reach: AccountReach = { portalEnabled: true, canAnnounceToAccounts: true };
const future = new Date(Date.now() + 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();

const gallery = (patch: Record<string, unknown> = {}) => ({
  id: 1,
  customer_email: 'anna@example.test',
  expires_at: future,
  is_draft: false,
  is_archived: false,
  welcome_message: '',
  customer_accounts: [
    { id: 11, email: 'anna@example.test', display_name: 'Anna Muster' },
    { id: 12, email: 'ben@example.test', display_name: 'Ben Beispiel' },
  ],
  ...patch,
}) as unknown as Event;

describe('accountsAnnounceable', () => {
  it('is true for a published, live gallery and false for a draft, archived or expired one', () => {
    expect(accountsAnnounceable(gallery())).toBe(true);
    expect(accountsAnnounceable(gallery({ expires_at: null }))).toBe(true);
    expect(accountsAnnounceable(gallery({ is_draft: true }))).toBe(false);
    expect(accountsAnnounceable(gallery({ is_archived: 1 }))).toBe(false);
    expect(accountsAnnounceable(gallery({ expires_at: past }))).toBe(false);
  });
});

describe('eventNotice for the complete-gallery mail', () => {
  it('folds one person in both fields into the portal version, even with a welcome message', () => {
    const notice = eventNotice(gallery({ welcome_message: 'Hallo!' }), reach, { preferPortal: true });
    expect(notice).toMatchObject({ inlineEmail: null, accountCount: 2 });
    expect(notice.accountNames).toEqual(['Anna Muster', 'Ben Beispiel']);
  });

  it('…where the gallery email keeps her by default (the welcome message)', () => {
    const notice = eventNotice(gallery({ welcome_message: 'Hallo!' }), reach);
    expect(notice).toMatchObject({ inlineEmail: 'anna@example.test', accountCount: 1 });
  });

  it('lists only the customer email, unfolded, when no account is mailed', () => {
    for (const g of [gallery({ is_draft: true }), gallery({ is_archived: true }), gallery({ expires_at: past })]) {
      expect(eventNotice(g, reach, { preferPortal: true, accountsAnnounced: accountsAnnounceable(g) }))
        .toEqual({ inlineEmail: 'anna@example.test', accountNames: [], accountCount: 0, skippedAccountCount: 0 });
    }
  });
});
