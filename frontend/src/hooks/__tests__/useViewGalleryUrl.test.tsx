import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const perms = { granted: new Set<string>() };
vi.mock('../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasPermission: (p: string) => perms.granted.has(p) }),
}));

import { useViewGalleryUrl } from '../useViewGalleryUrl';

describe('useViewGalleryUrl', () => {
  beforeEach(() => { perms.granted = new Set(); });

  it('opens the admin preview when the admin may view the event and its photos', () => {
    perms.granted = new Set(['events.view', 'photos.view']);
    const { result } = renderHook(() => useViewGalleryUrl());
    expect(result.current('/gallery/wed/abc')).toMatch(/\/gallery\/wed\/abc\?admin_preview=1$/);
  });

  it('falls back to the plain share link without photos.view', () => {
    perms.granted = new Set(['events.view']);
    const { result } = renderHook(() => useViewGalleryUrl());
    expect(result.current('/gallery/wed/abc')).toMatch(/\/gallery\/wed\/abc$/);
  });

  it('falls back to the plain share link while no permissions are known', () => {
    const { result } = renderHook(() => useViewGalleryUrl());
    expect(result.current('/gallery/wed/abc')).not.toContain('admin_preview');
  });
});
