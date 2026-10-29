/**
 * The Settings entry follows the tabs a role can see.
 *
 * The sidebar entry and the header's Settings item used to require
 * `settings.view`, while the tabs themselves accept narrower permissions
 * (branding.view, cms.edit, …). Once a section takes the menu over, the entry
 * is the only way back to those tabs after "Back to menu"; and a role with no
 * settings permission at all could still open a Settings page with nothing on
 * it through the header.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { useHasVisibleSettings, useSettingsNavGroups } from '../settingsNav';

let granted: string[] = [];
let superAdmin = false;
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasAnyPermission: (perms: string[]) => perms.some((p) => granted.includes(p)),
    hasPermission: (p: string) => granted.includes(p),
    isLoading: false,
    isSuperAdmin: superAdmin,
  }),
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {} }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const read = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8');

describe('useHasVisibleSettings', () => {
  it('limits installation payment configuration to super admins', () => {
    granted = ['settings.integrations'];
    superAdmin = false;
    expect(renderHook(() => useSettingsNavGroups()).result.current.flatMap((g) => g.items).some((i) => i.key === 'payments')).toBe(false);
    superAdmin = true;
    expect(renderHook(() => useSettingsNavGroups()).result.current.flatMap((g) => g.items).some((i) => i.key === 'payments')).toBe(true);
    superAdmin = false;
  });
  it('is true for a role with one narrow settings permission', () => {
    granted = ['branding.view'];
    expect(renderHook(() => useHasVisibleSettings()).result.current).toBe(true);
  });

  it('is false for a role with no settings permission', () => {
    granted = ['events.view'];
    expect(renderHook(() => useHasVisibleSettings()).result.current).toBe(false);
  });

  it('gates both entry points', () => {
    // The sidebar filters its Settings item on the visible groups, and the
    // header's Settings item reads the hook; neither checks settings.view.
    // The sidebar now derives this for every section from the section's own
    // nav hook; Settings is the SETTINGS_PATH row of that map.
    expect(read('components/admin/AdminSidebar.tsx')).toMatch(/\[SETTINGS_PATH\]: \{ count: settingsGroups\.length \}/);
    expect(read('components/admin/AdminSidebar.tsx')).toMatch(/if \(section\) return section\.count > 0;/);
    expect(read('components/admin/AdminHeader.tsx')).toMatch(/hasVisibleSettings && \(/);
  });
});
