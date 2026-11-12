import { useQuery } from '@tanstack/react-query';
import { useFeatureEnabled } from '../contexts/FeatureFlagsContext';
import { useAnyPermission } from './usePermission';
import { whatsappService } from '../services/whatsapp.service';

/**
 * Whether WhatsApp is set up on this install: the `whatsapp` feature flag is
 * on and the WhatsApp settings are switched on (enabling them needs the phone
 * number ID, template and access token). An admin who may not read those
 * settings gets false.
 */
export function useWhatsAppConfigured(): boolean {
  const flagOn = useFeatureEnabled('whatsapp');
  const canRead = useAnyPermission(['settings.view', 'whatsapp.view']);
  const { data } = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: () => whatsappService.getConfig(),
    enabled: flagOn && canRead,
    staleTime: 60_000,
  });
  return flagOn && canRead && Boolean(data?.enabled);
}
