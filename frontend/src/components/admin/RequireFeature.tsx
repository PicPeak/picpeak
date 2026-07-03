import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';

interface RequireFeatureProps {
  flag: FeatureKey;
  fallback?: string;
}

/**
 * Route guard that redirects to /admin/dashboard when the named feature
 * flag is OFF. Used so deep links (or stale bookmarks) to disabled
 * surfaces don't render an empty page or a half-loaded view.
 *
 * Mounted as the `element` of a parent <Route>, with the gated routes as
 * children — see App.tsx.
 */
export const RequireFeature: React.FC<RequireFeatureProps> = ({ flag, fallback = '/admin/dashboard' }) => {
  const { flags, isLoading } = useFeatureFlags();
  // Wait for the first fetch — otherwise we'd briefly fall back to the
  // default-flags object and could redirect on a transient false.
  if (isLoading) return null;
  if (!flags[flag]) return <Navigate to={fallback} replace />;
  return <Outlet />;
};
