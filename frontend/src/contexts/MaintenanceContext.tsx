import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { setMaintenanceModeCallback } from '../config/api';
import { usePublicSettings } from '../hooks/usePublicSettings';

interface MaintenanceContextType {
  isMaintenanceMode: boolean;
  setMaintenanceMode: (enabled: boolean) => void;
}

const MaintenanceContext = createContext<MaintenanceContextType | undefined>(undefined);

export const useMaintenanceMode = () => {
  const context = useContext(MaintenanceContext);
  if (!context) {
    throw new Error('useMaintenanceMode must be used within MaintenanceProvider');
  }
  return context;
};

interface MaintenanceProviderProps {
  children: ReactNode;
}

export const MaintenanceProvider: React.FC<MaintenanceProviderProps> = ({ children }) => {
  const [isMaintenanceMode, setIsMaintenanceMode] = useState(false);

  // Polls /public/settings every 30s so a maintenance flag flipped server-side propagates
  // without a refresh. 503 responses are caught by the axios interceptor in config/api.ts
  // (which calls setMaintenanceModeCallback below), so we only need to read the explicit
  // maintenance_mode flag here.
  const { data: settings } = usePublicSettings({ refetchInterval: 30_000 });

  useEffect(() => {
    if (settings?.maintenance_mode !== undefined) {
      setIsMaintenanceMode(settings.maintenance_mode);
    }
  }, [settings]);

  useEffect(() => {
    setMaintenanceModeCallback((enabled: boolean) => {
      setIsMaintenanceMode(enabled);
    });

    return () => {
      setMaintenanceModeCallback(null as any);
    };
  }, []);

  const setMaintenanceMode = (enabled: boolean) => {
    setIsMaintenanceMode(enabled);
  };

  return (
    <MaintenanceContext.Provider value={{ isMaintenanceMode, setMaintenanceMode }}>
      {children}
    </MaintenanceContext.Provider>
  );
};