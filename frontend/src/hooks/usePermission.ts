import { usePermissions } from '../contexts/PermissionsContext';

/**
 * Hook to check if the current user has a specific permission.
 *
 * @param permission - The permission to check
 * @returns boolean indicating if the user has the permission
 */
export function usePermission(permission: string): boolean {
  const { hasPermission } = usePermissions();
  return hasPermission(permission);
}

/**
 * Hook to check if the current user has any of the specified permissions.
 *
 * @param permissions - Array of permissions to check
 * @returns boolean indicating if the user has any of the permissions
 */
export function useAnyPermission(permissions: string[]): boolean {
  const { hasAnyPermission } = usePermissions();
  return hasAnyPermission(permissions);
}
