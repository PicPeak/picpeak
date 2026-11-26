/**
 * Flag-gated Settings tabs are listed once and filtered by
 * settingsTabGatedOff. This pins the order and visibility the per-item flag
 * spreads used to produce, for each gating flag on its own, all on, all off,
 * and each CRM document flag; payments stays a super-admin check.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useSettingsNavGroups } from '../settingsNav';

let flags: Record<string, boolean> = {};
let superAdmin = false;
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasAnyPermission: () => true,
    hasPermission: () => true,
    isLoading: false,
    isSuperAdmin: superAdmin,
  }),
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));

const FLAG_NAMES = ['printSales', 'albumProducts', 'userManagement', 'slideshow', 'transfers',
  'quotes', 'bills', 'contracts', 'documents', 'accounting', 'whatsapp', 'projects'];

// The navigation as the spreads wrote it: group order, item order, and the
// condition each gated item was listed under.
const expected = (f: Record<string, boolean>, isSuperAdmin: boolean): string[][] => [
  [...(f.printSales ? ['printSales'] : []), ...(f.albumProducts ? ['albumProducts'] : []), 'features', 'general', 'events', 'eventTypes'],
  [...(f.userManagement ? ['users'] : [])],
  ['branding', 'watermark', 'categories', 'thumbnails', 'downloads', 'styling', 'cms', ...(f.slideshow ? ['slideshow'] : [])],
  ['email', 'moderation', ...(f.transfers ? ['transfers'] : [])],
  ['security', 'sso', 'imageSecurity', 'seo'],
  [...(isSuperAdmin ? ['payments'] : []), 'apiTokens', 'webhooks'],
  ['businessProfile',
    ...(f.quotes || f.bills || f.contracts || f.documents ? ['crm'] : []),
    ...(f.projects ? ['briefTemplates'] : []),
    ...(f.contracts ? ['contracts'] : []),
    ...(f.accounting ? ['accounting'] : []),
    ...(f.whatsapp ? ['whatsapp'] : [])],
  ['status', 'health', 'analytics', 'usage', 'backup'],
].filter((g) => g.length > 0);

const only = (name: string | null) => Object.fromEntries(FLAG_NAMES.map((n) => [n, n === name]));
const cases: Array<[string, Record<string, boolean>]> = [
  ['all off', only(null)],
  ['all on', Object.fromEntries(FLAG_NAMES.map((n) => [n, true]))],
  ...FLAG_NAMES.map((n): [string, Record<string, boolean>] => [`only ${n}`, only(n)]),
];

describe('useSettingsNavGroups flag gating', () => {
  it.each(cases.flatMap(([name, f]) => [[name, false, f], [name, true, f]] as const))(
    '%s (super admin: %s)',
    (_name, isSuperAdmin, f) => {
      flags = f;
      superAdmin = isSuperAdmin;
      const groups = renderHook(() => useSettingsNavGroups()).result.current;
      expect(groups.map((g) => g.items.map((i) => i.key))).toEqual(expected(f, isSuperAdmin));
    },
  );

  it('keeps the transfers description on the gated item', () => {
    flags = only('transfers');
    const items = renderHook(() => useSettingsNavGroups()).result.current.flatMap((g) => g.items);
    expect(items.find((i) => i.key === 'transfers')?.description).toBe('Which file types clients may send you, and how large.');
  });
});
