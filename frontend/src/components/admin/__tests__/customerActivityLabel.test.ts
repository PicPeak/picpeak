/**
 * The customer activity card drops the customer's address from the shared
 * admin.activities labels. Where the address does not trail a colon
 * ("Password reset requested for customer {{email}}", "Kunden-Einladung
 * gesendet an {{email}}") that left a dangling preposition, so those types
 * carry a card label of their own, in every locale that has the shared one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import i18n from '../../../i18n/config';
import { customerActivityLabel } from '../CustomerActivityCard';
import type { CustomerActivityEntry } from '../../../services/customerAdmin.service';

const localeFiles = import.meta.glob<Record<string, unknown>>('../../../i18n/locales/*.json', { eager: true, import: 'default' });
const locales = Object.fromEntries(
  Object.entries(localeFiles).map(([p, json]) => [p.match(/(\w+)\.json$/)![1], json]),
);
const section = (lng: string, name: string) =>
  ((locales[lng].admin as Record<string, unknown>)?.[name] ?? {}) as Record<string, string>;

const entry = (type: string, metadata = {}): CustomerActivityEntry =>
  ({ id: 1, type, at: null, actorType: 'admin', actorName: null, eventId: null, metadata }) as CustomerActivityEntry;

// The address may go only where it trails a colon: "Customer logged in: {{email}}".
const dropsCleanly = (template: string) =>
  !template.includes('{{email}}') || /:\s*\{\{email\}\}\s*$/.test(template);

describe('customer activity card labels', () => {
  afterAll(async () => { await i18n.changeLanguage('en'); });

  for (const lng of Object.keys(locales)) {
    describe(lng, () => {
      beforeAll(async () => { await i18n.changeLanguage(lng); });

      it('never leaves a label hanging on the dropped address', () => {
        const shared = section(lng, 'activities');
        const card = section(lng, 'customerActivity');
        for (const [type, template] of Object.entries(shared)) {
          if (!type.startsWith('customer_') || dropsCleanly(template)) continue;
          // A card key in this locale, or i18next falls through to English.
          expect(card[type], `${lng} admin.customerActivity.${type}`).toBeTruthy();
          expect(customerActivityLabel(i18n.t, entry(type))).toBe(card[type]);
        }
      });

      it('renders no raw placeholder for any customer type', () => {
        for (const type of Object.keys(section('en', 'activities')).filter((k) => k.startsWith('customer_'))) {
          // count is one of the metadata keys the timeline passes through.
          expect(customerActivityLabel(i18n.t, entry(type, { count: 2 })), `${lng} ${type}`).not.toMatch(/\{\{|\s$/);
        }
      });
    });
  }

  it('reads the reported English and German lines without a dangling tail', async () => {
    await i18n.changeLanguage('en');
    expect(customerActivityLabel(i18n.t, entry('customer_password_reset_requested'))).toBe('Password reset requested');
    expect(customerActivityLabel(i18n.t, entry('customer_invitation_created'))).toBe('Invitation sent');
    expect(customerActivityLabel(i18n.t, entry('customer_login'))).toBe('Customer logged in');
    await i18n.changeLanguage('de');
    expect(customerActivityLabel(i18n.t, entry('customer_invitation_created'))).toBe('Einladung gesendet');
    expect(customerActivityLabel(i18n.t, entry('customer_login'))).toBe('Kunde angemeldet');
  });
});
