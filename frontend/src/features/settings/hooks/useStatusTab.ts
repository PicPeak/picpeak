import { useQuery } from '@tanstack/react-query';
import { settingsService } from '../../../services/settings.service';

export function useStatusTab() {
  // Fetch storage info
  const { data: storageInfo } = useQuery({
    queryKey: ['admin-storage-info'],
    queryFn: () => settingsService.getStorageInfo(),
  });

  // Fetch system status
  const { data: systemStatus } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => settingsService.getSystemStatus(),
    refetchInterval: 30000
  });

  return {
    storageInfo,
    systemStatus,
  };
}
