import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The way back to the customer portal for a gallery opened from it. Only
 * rendered for a portal session (`viaCustomer`), which the server sets on the
 * tokens the portal mints, so a share-link visitor never gets it. The
 * dashboard is the portal's home; with the portal session gone it sends the
 * visitor to the customer login rather than to a dead page.
 */
export const BackToAccountLink: React.FC<{ className?: string; alwaysLabelled?: boolean }> = ({
  className,
  alwaysLabelled = false,
}) => {
  const { t } = useTranslation();
  const label = t('gallery.backToAccount', 'Back to your account');
  return (
    <Link
      to="/customer/dashboard"
      className={className}
      aria-label={label}
      title={label}
      data-testid="gallery-back-to-account"
    >
      <ArrowLeft className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
      {/* Icon only on a phone, where the header row is already full. */}
      <span className={alwaysLabelled ? undefined : 'hidden sm:inline'}>{label}</span>
    </Link>
  );
};
