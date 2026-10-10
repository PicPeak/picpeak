import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { settingsService } from '../../services/settings.service';

export const MaintenanceBanner: React.FC = () => {
  const [dismissed, setDismissed] = React.useState(false);
  
  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => settingsService.getAllSettings(),
    refetchInterval: 60000 // Check every minute
  });

  const isMaintenanceMode = settings?.general_maintenance_mode === true || 
                           settings?.general_maintenance_mode === 'true';

  if (!isMaintenanceMode || dismissed) {
    return null;
  }

  return (
    <div className="bg-warning-soft border-b border-warning-line">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-warning-text" />
            <p className="text-sm font-medium text-warning-text">
              Maintenance mode is currently enabled. Public access to galleries is restricted.
            </p>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="text-warning-text"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};