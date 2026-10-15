/**
 * Below lg the admin sidebar is a drawer, translated off screen while closed.
 * Closed, it has to leave the tab order and the accessibility tree (inert);
 * opened, focus has to move into it, and back to the control that opened it
 * when it closes (issue 2074). On lg+ it is always on screen and never inert.
 */
import React, { useRef, useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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

const Harness: React.FC = () => {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <button ref={toggleRef} onClick={() => setOpen(true)}>hamburger</button>
        <AdminSidebar isOpen={open} onClose={() => setOpen(false)} />
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

  it('is never inert on lg and wider, where it is always on screen', () => {
    stubViewport(false);
    const { container } = render(<Harness />);
    expect(drawer(container)).not.toHaveAttribute('inert');
  });
});
