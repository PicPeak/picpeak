import React, { useState } from 'react';
import { Outlet, Navigate } from 'react-router-dom';

import { useAdminAuth } from '../../contexts';
import { FeatureFlagsProvider } from '../../contexts/FeatureFlagsContext';
import { useSessionTimeout } from '../../hooks/useSessionTimeout';
import { AdminSidebar } from './AdminSidebar';
import { AdminHeader } from './AdminHeader';
import { MaintenanceBanner } from './MaintenanceBanner';
import { MandatoryPasswordChangeModal } from './MandatoryPasswordChangeModal';

export const AdminLayout: React.FC = () => {
  const { isAuthenticated, isLoading, mustChangePassword } = useAdminAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
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
        mustChangePassword={mustChangePassword}
      />
    </FeatureFlagsProvider>
  );
};

interface AdminLayoutInnerProps {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  mustChangePassword: boolean;
}

const AdminLayoutInner: React.FC<AdminLayoutInnerProps> = ({ sidebarOpen, setSidebarOpen, mustChangePassword }) => {
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
        <AdminSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 h-screen">
        {/* Header - disabled when password change required */}
        <div className={mustChangePassword ? 'pointer-events-none opacity-50' : ''}>
          <AdminHeader onMenuClick={() => setSidebarOpen(true)} />
        </div>
        
        {/* Maintenance mode banner */}
        <MaintenanceBanner />

        {/* Page content - disabled when password change required */}
        <main id="main-content" className={`flex-1 px-4 sm:px-6 lg:px-8 py-8 overflow-y-auto ${mustChangePassword ? 'opacity-50 pointer-events-none' : ''}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
};

AdminLayout.displayName = 'AdminLayout';