import { usePublicSettings } from './usePublicSettings';

export function useWatermarkSettings() {
  const { data: settings, isLoading } = usePublicSettings();

  return {
    watermarkEnabled: Boolean(settings?.branding_watermark_enabled),
    loading: isLoading,
  };
}
