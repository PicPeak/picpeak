import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { MaintenanceMode } from './MaintenanceMode';
import { useMaintenanceMode } from '../contexts/MaintenanceContext';
import { setMaintenanceModeCallback } from '../config/api';

interface MaintenanceWrapperProps {
  children: React.ReactNode;
}

// Maintenance detection lives in two places:
//   1. The axios interceptor in config/api.ts flips the flag on any 503 response.
//   2. MaintenanceContext polls /public/settings every 30s and reads the explicit
//      maintenance_mode field (via the shared usePublicSettings hook).
//
// The maintenance screen ONLY blocks customer/gallery/public routes. Admin
// routes (/admin/*) are never blocked: an admin must always be able to reach
// the panel to turn maintenance back off, and the admin auth layer already
// handles access (AdminLayout redirects a logged-out admin to /admin/login).
// Gating /admin/* here on an "is the admin logged in?" check is what caused the
// lockout — it hid the login page itself, and after login the check went stale
// (login → dashboard is a client-side nav within /admin, so it never re-ran),
// leaving a logged-in admin stuck on the maintenance screen.
export const MaintenanceWrapper: React.FC<MaintenanceWrapperProps> = ({ children }) => {
  const location = useLocation();
  const { isMaintenanceMode, setMaintenanceMode } = useMaintenanceMode();

  const isAdminRoute = location.pathname.startsWith('/admin');

  useEffect(() => {
    setMaintenanceModeCallback((enabled: boolean) => {
      setMaintenanceMode(enabled);
    });
  }, [setMaintenanceMode]);

  if (isMaintenanceMode && !isAdminRoute) {
    return <MaintenanceMode />;
  }

  return <>{children}</>;
};
