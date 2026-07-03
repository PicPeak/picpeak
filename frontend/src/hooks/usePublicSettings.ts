import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { publicSettingsService, type PublicSettings } from '../services/publicSettings.service';

export const PUBLIC_SETTINGS_QUERY_KEY = ['public-settings'] as const;

type PublicSettingsQueryOptions = Omit<
  UseQueryOptions<PublicSettings, Error>,
  'queryKey' | 'queryFn'
>;

export function usePublicSettings(options?: PublicSettingsQueryOptions) {
  return useQuery<PublicSettings, Error>({
    queryKey: PUBLIC_SETTINGS_QUERY_KEY,
    queryFn: () => publicSettingsService.getPublicSettings(),
    staleTime: 60_000,
    ...options,
  });
}
