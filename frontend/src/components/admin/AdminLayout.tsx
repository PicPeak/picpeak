import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAdminAuth } from '../../contexts';
import { FeatureFlagsProvider } from '../../contexts/FeatureFlagsContext';
import { UploadSessionProvider } from '../../contexts/UploadSessionContext';
import { UploadProgressBar } from './UploadProgressBar';
import { UnsavedChangesProvider } from '../../contexts/UnsavedChangesContext';
import { useSessionTimeout } from '../../hooks/useSessionTimeout';
import { AdminSidebar } from './AdminSidebar';
import { AdminHeader } from './AdminHeader';
import { MaintenanceBanner } from './MaintenanceBanner';
import { MandatoryPasswordChangeModal } from './MandatoryPasswordChangeModal';
import { CommandPalette } from './CommandPalette';
import { BottomBarSlotContext } from './bottomBarSlot';
import { FillViewportContext, useFillViewportCounter } from './fillViewport';

const SIDEBAR_COLLAPSED_KEY = 'admin-sidebar-collapsed';
const ProductUsageNotice = lazy(() => import('./ProductUsageNotice'));
const UsageReportingPrompt = lazy(() => import('./UsageReportingPrompt'));

export const AdminLayout: React.FC = () => {
  const { isAuthenticated, isLoading, mustChangePassword } = useAdminAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  });

  const setSidebarCollapsed = (v: boolean) => {
    setSidebarCollapsedState(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0');
    }
  };

  // Handle session timeout
  useSessionTimeout();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-accent-dark border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-neutral-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  // FeatureFlagsProvider wraps the entire admin chrome — sidebar reads
  // flags to decide which surfaces to render, the Features tab reads/writes
  // the same source. Mounted INSIDE the auth-required tree so the GET to
  // /api/admin/feature-flags has a session cookie attached.
  return (
    <FeatureFlagsProvider>
      {/* Photo uploads run here, above the page, so the upload modal can close
          as soon as an upload starts and the bar survives navigating within
          the admin. Settings forms register their dirty state in
          UnsavedChangesProvider; the sidebar and header ask before navigating
          away from unsaved edits. */}
      <UploadSessionProvider>
        <UnsavedChangesProvider>
          <AdminLayoutInner
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
            mustChangePassword={mustChangePassword}
          />
        </UnsavedChangesProvider>
      </UploadSessionProvider>
    </FeatureFlagsProvider>
  );
};

interface AdminLayoutInnerProps {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  mustChangePassword: boolean;
}

const AdminLayoutInner: React.FC<AdminLayoutInnerProps> = ({ sidebarOpen, setSidebarOpen, sidebarCollapsed, setSidebarCollapsed, mustChangePassword }) => {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bottomBarSlot, setBottomBarSlot] = useState<HTMLDivElement | null>(null);
  // Pages that give their panes their own scrollbars (useFillViewport).
  const [fillViewport, setFillViewport] = useFillViewportCounter();
  const { t } = useTranslation();

  // Cmd+K on a Mac, Ctrl+K everywhere else. NOT "either modifier": Ctrl+K on
  // macOS is kill-to-end-of-line in every text field, and claiming it would
  // take a working editing key away from anyone typing in the admin. Shift and
  // Alt disqualify too, so Cmd+Shift+K stays free for whatever else wants it.
  //
  // Registered on the layout rather than inside the palette so the listener
  // exists whether or not the palette is mounted, and is torn down with the
  // admin shell. Suppressed while the mandatory password change is up:
  // nothing else is reachable then.
  useEffect(() => {
    if (mustChangePassword) return;
    // `navigator.platform` is deprecated; an empty value simply falls through
    // to the Ctrl branch, which is the safe default on anything non-Apple.
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // The OTHER modifier disqualifies too, so Ctrl+Cmd+K stays free.
      const other = isMac ? e.ctrlKey : e.metaKey;
      if (mod && !other && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mustChangePassword]);

  return (
    // Explicit text colour on the admin shell: the branding theme sets
    // --color-text on <html> app-wide (GlobalThemeProvider applies it on every
    // non-gallery page, by design), so any admin component that forgot its own
    // colour class inherited it through `body { color: var(--color-text) }` and
    // rendered near-invisible on a dark-toned theme. Components with an
    // explicit class or `text-theme` still win over this.
    <div className="h-screen bg-canvas text-heading flex overflow-hidden">
      {/* Mandatory Password Change Modal */}
      {mustChangePassword && <MandatoryPasswordChangeModal />}

      <CommandPalette isOpen={paletteOpen && !mustChangePassword} onClose={() => setPaletteOpen(false)} />
      
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - disabled when password change required */}
      <div className={mustChangePassword ? 'pointer-events-none opacity-50' : ''}>
        <AdminSidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      </div>

      {/* Main content. `scrollbar-gutter: stable` on the column itself
          (via the inline style) reserves the scrollbar gutter once at
          the column level — so the header sits in the full column
          width AND lines up with the sidebar's right edge, while
          <main>'s scroll content honors the same gutter and never
          shifts when content overflows. Without this, the header and
          main each made their own decisions about the gutter, leaving
          a visible ~15px notch on the right edge of the header's
          border between the column's content area and the scrollbar. */}
      <div
        className="flex-1 flex flex-col min-w-0 h-screen overflow-y-auto"
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* Header - disabled when password change required */}
        <div className={mustChangePassword ? 'pointer-events-none opacity-50' : ''}>
          <AdminHeader onMenuClick={() => setSidebarOpen(true)} onOpenSearch={() => setPaletteOpen(true)} />
        </div>

        {/* Maintenance mode banner */}
        <MaintenanceBanner />

        {/* Live upload progress, sticky under the header */}
        <UploadProgressBar />

        {!mustChangePassword && <Suspense fallback={null}><ProductUsageNotice /></Suspense>}
        {!mustChangePassword && <Suspense fallback={null}><UsageReportingPrompt /></Suspense>}

        {/* Page content - disabled when password change required.
            overflow moved up to the column so the scrollbar gutter is
            reserved once at the column level (see above). main now
            just contributes its content + padding. */}
        <BottomBarSlotContext.Provider value={bottomBarSlot}>
          <FillViewportContext.Provider value={setFillViewport}>
            {/* Filling the column, <main> may shrink to the space left (min-h-0)
                and drops its bottom padding: the page's panes scroll down to
                the bottom bar, and pad their own content. */}
            <main
              id="main-content"
              className={`flex-1 px-4 sm:px-6 lg:px-8 py-8 ${fillViewport ? 'lg:min-h-0 lg:flex lg:flex-col lg:pb-0' : ''} ${mustChangePassword ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <Outlet />
            </main>
          </FillViewportContext.Provider>
        </BottomBarSlotContext.Provider>
        {/* Bottom bars (SettingsSaveBar) render here: after a <main> that
            fills the column, so they sit at the bottom of the window even
            when the page is shorter than it. */}
        <div
          ref={setBottomBarSlot}
          role="region"
          aria-label={t('settings.saveBar.region', 'Save or discard changes')}
          className={`sticky bottom-0 z-20 empty:hidden ${mustChangePassword ? 'opacity-50 pointer-events-none' : ''}`}
        />
      </div>
    </div>
  );
};

AdminLayout.displayName = 'AdminLayout';
