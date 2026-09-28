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

import { useHasVisibleSettings } from '../settingsNav';

let granted: string[] = [];
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasAnyPermission: (perms: string[]) => perms.some((p) => granted.includes(p)),
    hasPermission: (p: string) => granted.includes(p),
    isLoading: false,
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
    expect(read('components/admin/AdminSidebar.tsx')).toMatch(/item\.href === SETTINGS_PATH\) return settingsGroups\.length > 0/);
    expect(read('components/admin/AdminHeader.tsx')).toMatch(/hasVisibleSettings && \(/);
  });
});
