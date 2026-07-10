import React from 'react';
import type { ReactNode } from 'react';
import { usePermissions } from '../../contexts/PermissionsContext';

interface PermissionGateProps {
  permission?: string;
  permissions?: string[];
  requireAll?: boolean;
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * PermissionGate component that conditionally renders children based on user permissions.
 *
 * @param permission - A single permission to check
 * @param permissions - An array of permissions to check
 * @param requireAll - If true, requires all permissions (AND logic). If false, requires any permission (OR logic). Default: false
 * @param fallback - Content to render if permission check fails. Default: null
 * @param children - Content to render if permission check passes
 */
export const PermissionGate: React.FC<PermissionGateProps> = ({
  permission,
  permissions,
  requireAll = false,
  fallback = null,
  children,
}) => {
  const { hasPermission, hasAnyPermission, hasAllPermissions, isSuperAdmin } = usePermissions();

  // Super admin bypasses all permission checks
  if (isSuperAdmin) {
    return <>{children}</>;
  }

  // Check single permission
  if (permission) {
    if (hasPermission(permission)) {
      return <>{children}</>;
    }
    return <>{fallback}</>;
  }

  // Check multiple permissions
  if (permissions && permissions.length > 0) {
    const hasAccess = requireAll
      ? hasAllPermissions(permissions)
      : hasAnyPermission(permissions);

    if (hasAccess) {
      return <>{children}</>;
    }
    return <>{fallback}</>;
  }

  // If no permissions specified, render children (allow access)
  return <>{children}</>;
};

PermissionGate.displayName = 'PermissionGate';
