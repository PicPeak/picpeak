import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePublicSettings } from '../../hooks/usePublicSettings';

interface PoweredByProps {
  className?: string;
  style?: React.CSSProperties;
}

// "Powered by PicPeak" footer/login attribution. Reads the setting itself (like
// DynamicFavicon) so callers don't repeat the guard; hidden for white-label.
export const PoweredBy: React.FC<PoweredByProps> = ({ className, style }) => {
  const { t } = useTranslation();
  const { data: settings } = usePublicSettings();

  // Hide while settings are still loading too, otherwise a white-labelled
  // instance flashes the attribution before branding_hide_powered_by resolves.
  if (!settings || settings.branding_hide_powered_by) return null;

  return (
    <p className={className} style={style}>
      {t('common.poweredBy')} <span className="font-semibold">PicPeak</span>
    </p>
  );
};
