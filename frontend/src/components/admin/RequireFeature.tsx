import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';

interface RequireFeatureProps {
  /** Single required flag. Mutually exclusive with `anyOf`. */
  flag?: FeatureKey;
  /**
   * Pass when a surface belongs to more than one feature and should stay
   * reachable while ANY of them is on. The customer detail page is the case
   * this exists for: it hosts both the portal account fields and the
   * newsletter consent control, so a newsletter-only install must still be
   * able to open it (#1264).
   */
  anyOf?: FeatureKey[];
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
export const RequireFeature: React.FC<RequireFeatureProps> = ({
  flag,
  anyOf,
  fallback = '/admin/dashboard',
}) => {
  const { flags, isLoading } = useFeatureFlags();
  // Wait for the first fetch — otherwise we'd briefly fall back to the
  // default-flags object and could redirect on a transient false.
  if (isLoading) return null;
  const required = anyOf?.length ? anyOf : (flag ? [flag] : []);
  if (required.length > 0 && !required.some((key) => flags[key])) {
    return <Navigate to={fallback} replace />;
  }
  return <Outlet />;
};
