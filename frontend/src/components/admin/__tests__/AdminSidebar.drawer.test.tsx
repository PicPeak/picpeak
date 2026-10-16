/**
 * Below lg the admin sidebar is a drawer, translated off screen while closed.
 * Closed, it has to leave the tab order and the accessibility tree (inert);
 * opened, focus has to move into it, and back to the control that opened it
 * when it closes (issue 2074). On lg+ it is always on screen and never inert.
 */
import React, { useRef, useState } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => (typeof opts === 'string' ? opts : key),
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: () => true,
    hasAnyPermission: () => true,
    isLoading: false,
  }),
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {} }),
}));
vi.mock('../../../contexts/AdminDarkModeContext', () => ({
  useAdminDarkMode: () => ({ isDark: false }),
}));
vi.mock('../../../contexts/UnsavedChangesContext', () => ({
  useLeaveGuard: () => ({ confirmLeave: async () => true, isAnyDirty: false }),
  useGuardedLinkClick: () => (_e: unknown, _href: string, opts: { after?: () => void } = {}) => opts.after?.(),
}));
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: undefined }),
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getStorageInfo: vi.fn().mockResolvedValue(undefined), formatBytes: () => '0 B' },
}));
vi.mock('../VersionInfo', () => ({ VersionInfo: () => null }));

import { AdminSidebar } from '../AdminSidebar';
import adminLayoutSource from '../AdminLayout.tsx?raw';

function stubViewport(isDrawer: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: isDrawer && query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

// A viewport whose drawer breakpoint can be crossed mid-test.
function stubResizableViewport(initiallyDrawer: boolean) {
  let isDrawer = initiallyDrawer;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() { return isDrawer && query.includes('max-width'); },
      media: query,
      addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  return (next: boolean) => {
    isDrawer = next;
    act(() => listeners.forEach((cb) => cb()));
  };
}

const Harness: React.FC<{ path?: string }> = ({ path = '/admin/dashboard' }) => {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <button ref={toggleRef} onClick={() => setOpen(true)}>hamburger</button>
        {/* AdminLayout always passes onToggleCollapse: its button is `hidden lg:flex`. */}
        <AdminSidebar isOpen={open} onClose={() => setOpen(false)} onToggleCollapse={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

const drawer = (container: HTMLElement) => container.querySelector('.fixed.inset-y-0') as HTMLElement;

afterEach(cleanup);

describe('AdminSidebar drawer (issue 2074)', () => {
  it('is inert while closed below lg', () => {
    stubViewport(true);
    const { container } = render(<Harness />);
    expect(drawer(container)).toHaveAttribute('inert');
  });

  it('moves focus into the drawer on open and back to the opener on close', () => {
    stubViewport(true);
    const { container } = render(<Harness />);
    const hamburger = screen.getByText('hamburger');
    hamburger.focus();
    fireEvent.click(hamburger);

    expect(drawer(container)).not.toHaveAttribute('inert');
    expect(drawer(container).contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(drawer(container)).toHaveAttribute('inert');
    expect(document.activeElement).toBe(hamburger);
  });

  it('wraps Shift+Tab past the desktop-only collapse button', () => {
    stubViewport(true);
    // jsdom has no layout: stand in checkVisibility for the `hidden` class.
    const proto = HTMLElement.prototype as HTMLElement & { checkVisibility?: () => boolean };
    const original = proto.checkVisibility;
    proto.checkVisibility = function (this: HTMLElement) { return !this.closest('.hidden'); };
    try {
      // Section mode drops the footer widgets, so the collapse button is the
      // last focusable control in the drawer.
      const { container } = render(<Harness path="/admin/settings" />);
      fireEvent.click(screen.getByText('hamburger'));
      const first = document.activeElement as HTMLElement;
      expect(drawer(container).contains(first)).toBe(true);
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
      const collapse = screen.getByLabelText('Collapse sidebar');
      expect(document.activeElement).not.toBe(collapse);
      expect(document.activeElement).not.toBe(first);
      expect(drawer(container).contains(document.activeElement)).toBe(true);
    } finally {
      if (original) proto.checkVisibility = original;
      else delete proto.checkVisibility;
    }
  });

  it('still returns focus to the opener after an lg round trip with the drawer open', () => {
    const resize = stubResizableViewport(true);
    const { container } = render(<Harness />);
    const hamburger = screen.getByText('hamburger');
    hamburger.focus();
    fireEvent.click(hamburger);
    expect(drawer(container).contains(document.activeElement)).toBe(true);

    resize(false);
    resize(true);
    expect(drawer(container).contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(document.activeElement).toBe(hamburger);
  });

  it('keeps the sidebar out of keyboard reach during a mandatory password change', () => {
    // pointer-events-none alone leaves the keyboard in, and the drawer trap
    // would hold focus in a sidebar that cannot be used.
    expect(adminLayoutSource).toMatch(/\{\.\.\.\(mustChangePassword \? \{ inert: '' \} : \{\}\)\}/);
  });

  it('is never inert on lg and wider, where it is always on screen', () => {
    stubViewport(false);
    const { container } = render(<Harness />);
    expect(drawer(container)).not.toHaveAttribute('inert');
  });
});
