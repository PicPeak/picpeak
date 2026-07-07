import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { api } from '../config/api';
import { useAdminAuth } from './AdminAuthContext';
import type { AdminPermissions } from '../types';

interface PermissionsContextType {
  permissions: string[];
  role: { name: string; displayName: string } | null;
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (permissions: string[]) => boolean;
  hasAllPermissions: (permissions: string[]) => boolean;
  isSuperAdmin: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const PermissionsContext = createContext<PermissionsContextType | undefined>(undefined);

export const usePermissions = () => {
  const context = useContext(PermissionsContext);
  if (!context) {
    throw new Error('usePermissions must be used within a PermissionsProvider');
  }
  return context;
};

interface PermissionsProviderProps {
  children: ReactNode;
}

export const PermissionsProvider: React.FC<PermissionsProviderProps> = ({ children }) => {
  const { isAuthenticated } = useAdminAuth();
  const [permissions, setPermissions] = useState<string[]>([]);
  const [role, setRole] = useState<{ name: string; displayName: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPermissions = useCallback(async () => {
    if (!isAuthenticated) {
      setPermissions([]);
      setRole(null);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const response = await api.get<AdminPermissions>('/admin/users/me/permissions');
      setPermissions(response.data.permissions || []);
      setRole(response.data.role || null);
    } catch (error) {
      // Clear permissions on auth failure
      setPermissions([]);
      setRole(null);
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  const hasPermission = useCallback(
    (permission: string): boolean => {
      // Super admin has all permissions
      if (role?.name === 'super_admin') {
        return true;
      }
      return permissions.includes(permission);
    },
    [permissions, role]
  );

  const hasAnyPermission = useCallback(
    (perms: string[]): boolean => {
      // Super admin has all permissions
      if (role?.name === 'super_admin') {
        return true;
      }
      return perms.some((p) => permissions.includes(p));
    },
    [permissions, role]
  );

  const hasAllPermissions = useCallback(
    (perms: string[]): boolean => {
      // Super admin has all permissions
      if (role?.name === 'super_admin') {
        return true;
      }
      return perms.every((p) => permissions.includes(p));
    },
    [permissions, role]
  );

  const isSuperAdmin = role?.name === 'super_admin';

  const refresh = useCallback(async () => {
    await fetchPermissions();
  }, [fetchPermissions]);

  return (
    <PermissionsContext.Provider
      value={{
        permissions,
        role,
        hasPermission,
        hasAnyPermission,
        hasAllPermissions,
        isSuperAdmin,
        isLoading,
        refresh,
      }}
    >
      {children}
    </PermissionsContext.Provider>
  );
};

export { PermissionsContext };
