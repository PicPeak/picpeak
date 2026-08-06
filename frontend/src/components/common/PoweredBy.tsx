import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePublicSettings } from '../../hooks/usePublicSettings';

interface PoweredByProps {
  /** Extra classes applied to the wrapping `<p>`, for per-context styling. */
  className?: string;
  /** Inline styles applied to the wrapping `<p>`. */
  style?: React.CSSProperties;
}

/**
 * Renders the "Powered by PicPeak" attribution shown in public footers and
 * login screens.
 *
 * The component reads the public `branding_hide_powered_by` setting itself —
 * like `DynamicFavicon` / `RobotsMetaTags` — and renders nothing when the admin
 * has enabled white-labeling. Keeping the visibility check inside the component
 * lets every call site drop in `<PoweredBy />` instead of repeating the guard
 * or drilling the flag down through layout props.
 *
 * Only the "Powered by" prefix is translated (`common.poweredBy`); the brand
 * name is rendered verbatim and never localized.
 */
export const PoweredBy: React.FC<PoweredByProps> = ({ className, style }) => {
  const { t } = useTranslation();
  const { data: settings } = usePublicSettings();

  if (settings?.branding_hide_powered_by) {
    return null;
  }

  return (
    <p className={className} style={style}>
      {t('common.poweredBy')} <span className="font-semibold">PicPeak</span>
    </p>
  );
};
