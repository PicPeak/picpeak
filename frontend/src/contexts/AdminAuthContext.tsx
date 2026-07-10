import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { api } from '../config/api';
import { authService } from '../services';
import type { AdminUser } from '../types';

interface AdminAuthContextType {
  isAuthenticated: boolean;
  user: AdminUser | null;
  login: (token: string, user: AdminUser) => void;
  logout: () => void;
  isLoading: boolean;
  error: string | null;
  mustChangePassword: boolean;
  updatePasswordChanged: () => void;
  updateUserProfile: (updates: Partial<AdminUser>) => void;
}

const AdminAuthContext = createContext<AdminAuthContextType | undefined>(undefined);

export const useAdminAuth = () => {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return context;
};

interface AdminAuthProviderProps {
  children: ReactNode;
}

export const AdminAuthProvider: React.FC<AdminAuthProviderProps> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  useEffect(() => {
    // Check if user has a valid token on mount
    const checkAuth = async () => {
      try {
        const storedUser = sessionStorage.getItem('admin_user');
        if (storedUser) {
          try {
            setUser(JSON.parse(storedUser));
          } catch (err) {
            sessionStorage.removeItem('admin_user');
          }
        }

        const response = await api.get<{ valid: boolean; type: string; adminUsername?: string; user?: string }>(
          '/auth/session'
        );

        if (response.data?.valid && response.data.type === 'admin') {
          setIsAuthenticated(true);
        } else {
          sessionStorage.removeItem('admin_user');
          setIsAuthenticated(false);
          setUser(null);
        }
      } catch (error) {
        // Auth check failed - user needs to login
        sessionStorage.removeItem('admin_user');
        setIsAuthenticated(false);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };
    
    checkAuth();
  }, []);

  const login = (_token: string, user: AdminUser) => {
    // Token is already stored in cookie by authService
    setUser(user);
    setError(null);
    setIsAuthenticated(true);
    setMustChangePassword(user.mustChangePassword || false);
    sessionStorage.setItem('admin_user', JSON.stringify(user));
  };

  const logout = () => {
    sessionStorage.removeItem('admin_user');
    authService.adminLogout();
    setIsAuthenticated(false);
    setUser(null);
    setMustChangePassword(false);
  };

  const updatePasswordChanged = () => {
    setMustChangePassword(false);
    if (user) {
      setUser({
        ...user,
        mustChangePassword: false
      });
      sessionStorage.setItem('admin_user', JSON.stringify({
        ...user,
        mustChangePassword: false
      }));
    }
  };

  const updateUserProfile = (updates: Partial<AdminUser>) => {
    setUser((prev) => {
      if (!prev) {
        return prev;
      }
      const nextUser = { ...prev, ...updates };
      sessionStorage.setItem('admin_user', JSON.stringify(nextUser));
      return nextUser;
    });
  };

  return (
    <AdminAuthContext.Provider
      value={{
        isAuthenticated,
        user,
        login,
        logout,
        isLoading,
        error,
        mustChangePassword,
        updatePasswordChanged,
        updateUserProfile,
      }}
    >
      {children}
    </AdminAuthContext.Provider>
  );
};
