import React, { useState } from 'react';
import { Outlet, Navigate } from 'react-router-dom';

import { useAdminAuth } from '../../contexts';
import { FeatureFlagsProvider } from '../../contexts/FeatureFlagsContext';
import { useSessionTimeout } from '../../hooks/useSessionTimeout';
import { AdminSidebar } from './AdminSidebar';
import { AdminHeader } from './AdminHeader';
import { MaintenanceBanner } from './MaintenanceBanner';
import { MigrationBanner } from './MigrationBanner';
import { MandatoryPasswordChangeModal } from './MandatoryPasswordChangeModal';

const SIDEBAR_COLLAPSED_KEY = 'admin-sidebar-collapsed';

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
      <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 flex items-center justify-center">
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
      <AdminLayoutInner
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        mustChangePassword={mustChangePassword}
      />
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
  return (
    <div className="h-screen bg-neutral-50 dark:bg-neutral-950 flex overflow-hidden">
      {/* Mandatory Password Change Modal */}
      {mustChangePassword && <MandatoryPasswordChangeModal />}
      
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
          <AdminHeader onMenuClick={() => setSidebarOpen(true)} />
        </div>

        {/* Maintenance mode banner */}
        <MaintenanceBanner />

        {/* One-time migration banner — flip the constant in MigrationBanner.tsx
            (or remove this mount) after operators have had time to update their
            docker-compose.yml. See #669. */}
        <MigrationBanner />

        {/* Page content - disabled when password change required.
            overflow moved up to the column so the scrollbar gutter is
            reserved once at the column level (see above). main now
            just contributes its content + padding. */}
        <main id="main-content" className={`flex-1 px-4 sm:px-6 lg:px-8 py-8 ${mustChangePassword ? 'opacity-50 pointer-events-none' : ''}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
};

AdminLayout.displayName = 'AdminLayout';