import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePublicSettings } from '../../hooks/usePublicSettings';

interface PoweredByProps {
  className?: string;
  style?: React.CSSProperties;
  /**
   * Render inside an existing paragraph — as ` | Powered by PicPeak` in a
   * `<span>` — rather than as its own `<p>`. The gallery footer appends the
   * attribution to its copyright line, and a `<p>` nested in a `<p>` is invalid.
   *
   * The separator belongs to the component on purpose: a caller placing its own
   * ` | ` would have to repeat the visibility guard to avoid leaving a dangling
   * separator behind, and repeating that guard is what #999 was fixing.
   */
  inline?: boolean;
}

// "Powered by PicPeak" footer/login attribution. Reads the setting itself (like
// DynamicFavicon) so callers don't repeat the guard; hidden for white-label.
export const PoweredBy: React.FC<PoweredByProps> = ({ className, style, inline = false }) => {
  const { t } = useTranslation();
  const { data: settings } = usePublicSettings();

  // Hide while settings are still loading too, otherwise a white-labelled
  // instance flashes the attribution before branding_hide_powered_by resolves.
  if (!settings || settings.branding_hide_powered_by) return null;

  const label = (
    <>
      {t('common.poweredBy')} <span className="font-semibold">PicPeak</span>
    </>
  );

  if (inline) {
    return <span className={className} style={style}> | {label}</span>;
  }

  return (
    <p className={className} style={style}>
      {label}
    </p>
  );
};
