import React from 'react';
import { Outlet } from 'react-router-dom';
import { AdminAuthProvider, PermissionsProvider } from '../../contexts';
import { AdminDarkModeProvider } from '../../contexts/AdminDarkModeContext';

export const AdminAuthWrapper: React.FC = () => {
  return (
    <AdminAuthProvider>
      <PermissionsProvider>
        <AdminDarkModeProvider>
          <Outlet />
        </AdminDarkModeProvider>
      </PermissionsProvider>
    </AdminAuthProvider>
  );
};

AdminAuthWrapper.displayName = 'AdminAuthWrapper';